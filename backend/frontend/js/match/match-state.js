// =============================================
// ARROWMATCH — Match State Manager
// Owns all match state mutations and business logic.
// Reacts to EventBus events; never touches the DOM directly.
//
// Flow:
//   WS event → EventBus → this module → mutates STATE → emits APP event → UI components react
//
// Depends on: core/state.js, core/api.js, core/utils.js,
//             core/event-bus.js, match/ws-manager.js, match/bot.js
// =============================================

// Per-match bot-fallback timers: { [matchId]: timerId }
const _botFallbackTimers = {};

// ── Start / complete / forfeit ────────────────────────────────────────────────

function startMatch(challenge, isCreator = false) {
  const myName     = STATE.profile?.name || 'You';
  const oppName    = challenge.creator_name || challenge.name || 'Opponent';
  const scoring    = challenge.scoring     || 'total';
  const arrowCount = challenge.arrow_count || challenge.arrowCount || STATE.arrowCount || 18;
  const dist       = challenge.distance    || '30m';
  const matchId    = challenge.matchId     || challenge.id;

  const newMs = {
    id: matchId,
    challengeId:   challenge.id,
    myName, oppName, scoring, arrowCount, dist,
    isBot:         challenge.isBot || false,
    arrowValues:   [],
    setMyScore:    0, setOppScore: 0, currentSet: 1, setArrowValues: [],
    complete:      false, isCreator,
  };

  STATE.activeMatches[matchId] = newMs;
  STATE.currentMatchId         = matchId;

  saveMatchState();
  _updateResumeTab();

  EventBus.emit(EVENT_TYPES.APP_MATCH_STARTED, { matchId, matchState: newMs });

  if (challenge.matchId && !challenge.isBot) {
    connectMatchSocket(matchId);
    _startBgStatusPoll();
  }
  if (isCreator && !challenge.isBot && challenge.matchId) {
    _scheduleBotFallback(challenge);
  }
}

function saveMatchState() {
  const toSave = {};
  for (const [id, ms] of Object.entries(STATE.activeMatches)) {
    if (!ms.complete) toSave[id] = ms;
  }
  localStorage.setItem('arrowmatch_active_matches', JSON.stringify(toSave));
  localStorage.removeItem('arrowmatch_match_state'); // clear legacy key
}

function restoreMatch() {
  if (!STATE.matchState) return;
  arrowValues = [...STATE.matchState.arrowValues];
  EventBus.emit(EVENT_TYPES.APP_MATCH_STARTED, {
    matchId:    STATE.currentMatchId,
    matchState: STATE.matchState,
    restored:   true,
  });
}

/** Switch the challenge scene to a different active match. */
function switchToMatch(matchId) {
  const ms = STATE.activeMatches[matchId];
  if (!ms)         { showToast('Match no longer active', 'error'); return; }
  if (ms.complete) { showToast('That match has already finished', 'info'); return; }

  // Save in-progress arrows for the current match
  const cur = STATE.activeMatches[STATE.currentMatchId];
  if (cur && !cur.complete) {
    cur.arrowValues    = [...arrowValues];
    cur.setArrowValues = cur.scoring === 'sets' ? [...arrowValues] : cur.setArrowValues;
    saveMatchState();
  }

  STATE.currentMatchId = matchId;
  arrowValues          = [...(ms.arrowValues || [])];
  EventBus.emit(EVENT_TYPES.APP_MATCH_SWITCHED, { matchId, matchState: ms });
}

/** Remove a match: close its WS, cancel bot timer, persist. */
function _removeActiveMatch(matchId) {
  disconnectMatchSocket(matchId);

  if (_botFallbackTimers[matchId]) {
    clearTimeout(_botFallbackTimers[matchId]);
    delete _botFallbackTimers[matchId];
  }

  delete STATE.activeMatches[matchId];

  if (STATE.currentMatchId === matchId) {
    const remaining    = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = remaining.length > 0
      ? remaining[remaining.length - 1]
      : null;
  }

  saveMatchState();
  _updateResumeTab();
  EventBus.emit(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, {
    activeMatches: STATE.activeMatches,
    currentMatchId: STATE.currentMatchId,
  });
}

/** Sync resume tab visibility and badge count. */
function _updateResumeTab() {
  const count = Object.values(STATE.activeMatches).filter(ms => !ms.complete).length;
  const tab   = document.getElementById('resume-tab');
  const badge = document.getElementById('match-count-badge');
  if (!tab) return;
  tab.classList.toggle('hidden', count === 0);
  if (badge) {
    badge.textContent = count > 1 ? count : '';
    badge.classList.toggle('hidden', count <= 1);
  }
}

// ── Match completion ──────────────────────────────────────────────────────────

function completeMatch(myScore, oppScore, targetMatchId) {
  const mid = targetMatchId || STATE.currentMatchId;
  const ms  = STATE.activeMatches[mid];
  if (!ms) return;

  const wasDisplayed = (mid === STATE.currentMatchId);

  ms.complete      = true;
  ms.myFinalScore  = myScore;
  ms.oppFinalScore = oppScore;

  _removeActiveMatch(mid);
  saveToHistory(ms);

  // Restart bg poller if other server matches still active
  const hasMore = Object.values(STATE.activeMatches).some(
    m => !m.complete && !m.isBot && m.id && !m.id.startsWith('local-')
  );
  if (hasMore) _startBgStatusPoll();

  EventBus.emit(EVENT_TYPES.APP_MATCH_COMPLETE, {
    matchId: mid,
    matchState: ms,
    myScore, oppScore,
    wasDisplayed,
  });
}

// ── Forfeit ───────────────────────────────────────────────────────────────────

async function forfeitMatch() {
  const ms  = STATE.matchState;
  if (!ms || ms.complete) return;

  const btn = document.getElementById('forfeit-btn');
  if (!btn) return;

  if (btn.dataset.confirming !== 'true') {
    btn.textContent        = 'Confirm forfeit?';
    btn.dataset.confirming = 'true';
    btn.style.background   = 'rgba(242,96,96,0.25)';
    btn._resetTimer = setTimeout(() => {
      btn.textContent        = '✕ Forfeit';
      btn.dataset.confirming = 'false';
      btn.style.background   = '';
    }, 4000);
    return;
  }

  clearTimeout(btn._resetTimer);
  btn.textContent        = 'Forfeiting…';
  btn.disabled           = true;
  btn.dataset.confirming = 'false';

  if (ms.isBot) {
    showToast('You forfeited. Better luck next time!', 'info');
    _forfeitAndExit(ms);
    return;
  }

  try {
    await api('POST', `/api/matches/${ms.id}/forfeit`);
    showToast('You forfeited. Better luck next time!', 'info');
    _forfeitAndExit(ms);
  } catch (e) {
    showToast(e.message || 'Forfeit failed — try again', 'error');
    btn.textContent = '✕ Forfeit';
    btn.disabled    = false;
  }
}

function _forfeitAndExit(ms) {
  ms.complete      = true;
  ms.myFinalScore  = 0;
  ms.oppFinalScore = 1;
  closeCreatorWaitSocket();
  _removeActiveMatch(ms.id);
  saveToHistory(ms);
  showScene('my-challenges');
}

// ── Rematch ───────────────────────────────────────────────────────────────────

async function proposeRematch() {
  const ms = STATE.matchState;
  if (!ms) return;

  if (ms.isBot) { _startBotRematch(ms); return; }

  const actionsEl = document.getElementById('complete-actions');
  const pendingEl = document.getElementById('rematch-pending');
  actionsEl.classList.add('hidden');
  pendingEl.classList.remove('hidden');

  try {
    await api('POST', `/api/matches/${ms.id}/rematch`);
  } catch (e) {
    showToast(e.message || 'Could not propose rematch', 'error');
    actionsEl.classList.remove('hidden');
    pendingEl.classList.add('hidden');
  }
}

async function acceptRematch() {
  const ms = STATE.matchState;
  if (!ms) return;
  document.getElementById('rematch-request').classList.add('hidden');
  try {
    const data = await api('POST', `/api/matches/${ms.id}/rematch/accept`);
    if (data?.new_match_id) _launchRematchMatch(data, ms);
  } catch (e) {
    showToast(e.message || 'Could not accept rematch', 'error');
    document.getElementById('rematch-request').classList.remove('hidden');
  }
}

async function declineRematch() {
  const ms = STATE.matchState;
  if (!ms) return;
  document.getElementById('rematch-request').classList.add('hidden');
  document.getElementById('complete-actions').classList.remove('hidden');
  try {
    await api('POST', `/api/matches/${ms.id}/rematch/decline`);
    showToast('Rematch declined', 'info');
  } catch {}
}

function _launchRematchMatch(data, prev) {
  document.getElementById('match-complete').classList.add('hidden');
  startMatch({
    id:         data.new_challenge_id || `rematch-${Date.now()}`,
    matchId:    data.new_match_id,
    name:       data.opponent_name || prev.oppName,
    scoring:    data.scoring       || prev.scoring,
    distance:   data.distance      || prev.dist,
    arrowCount: data.arrow_count   || prev.arrowCount,
    match_type: data.match_type    || 'private',
  });
}

function _startBotRematch(prev) {
  document.getElementById('match-complete').classList.add('hidden');
  startMatch({
    id:         `rematch-${Date.now()}`,
    name:       prev.oppName,
    isBot:      true,
    distance:   prev.dist,
    scoring:    prev.scoring,
    arrowCount: prev.arrowCount,
  });
}

function _resetRematchUI() {
  document.getElementById('complete-actions')?.classList.remove('hidden');
  document.getElementById('rematch-pending')?.classList.add('hidden');
  document.getElementById('rematch-request')?.classList.add('hidden');
}

// ── Bot fallback ──────────────────────────────────────────────────────────────

function _scheduleBotFallback(challenge) {
  const matchId    = challenge.matchId || challenge.id;
  const BOT_WAIT   = 2 * 60 * 1000;
  const startTime  = Date.now();

  if (_botFallbackTimers[matchId]) {
    clearTimeout(_botFallbackTimers[matchId]);
    delete _botFallbackTimers[matchId];
  }

  // Live countdown display
  function updateCountdown() {
    const ms = STATE.activeMatches[matchId];
    if (!ms || ms.complete || ms._opponentJoined) return;
    const elapsed   = Date.now() - startTime;
    const remaining = Math.max(0, Math.ceil((BOT_WAIT - elapsed) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = String(remaining % 60).padStart(2, '0');
    if (STATE.currentMatchId === matchId) {
      const oppEl = document.getElementById('ch-opp-name');
      if (oppEl) {
        oppEl.textContent = remaining > 0
          ? `Waiting for opponent (${mins}:${secs})`
          : 'Connecting bot…';
      }
    }
    if (remaining > 0) requestAnimationFrame(updateCountdown);
  }
  requestAnimationFrame(updateCountdown);

  _botFallbackTimers[matchId] = setTimeout(() => {
    delete _botFallbackTimers[matchId];
    const ms = STATE.activeMatches[matchId];
    if (!ms || ms.complete || ms._opponentJoined) return;

    const bot      = generateBotOpponent();
    bot.distance   = challenge.distance    || ms.dist       || '30m';
    bot.scoring    = challenge.scoring     || ms.scoring    || 'total';
    bot.arrowCount = challenge.arrow_count || ms.arrowCount || 18;

    ms.oppName = bot.name;
    ms.isBot   = true;
    saveMatchState();

    if (STATE.currentMatchId === matchId) {
      const oppEl = document.getElementById('ch-opp-name');
      if (oppEl) oppEl.textContent = bot.name;
    }
    showToast(`No opponent joined — ${bot.name} is challenging you!`, 'info');
  }, BOT_WAIT);
}

// ── Background status poll ────────────────────────────────────────────────────

let _bgStatusPollInterval = null;

function _startBgStatusPoll() {
  if (_bgStatusPollInterval) return;
  _bgStatusPollInterval = setInterval(_bgPollTick, 5000);
}

function _stopBgStatusPoll() {
  if (_bgStatusPollInterval) {
    clearInterval(_bgStatusPollInterval);
    _bgStatusPollInterval = null;
  }
}

async function _bgPollTick() {
  const matchEntries = Object.entries(STATE.activeMatches).filter(
    ([, ms]) => !ms.complete && !ms.isBot && ms.id && !ms.id.startsWith('local-')
  );

  if (matchEntries.length === 0) { _stopBgStatusPoll(); return; }

  for (const [matchId, ms] of matchEntries) {
    if (ms._polling) continue;
    try {
      const status = await api('GET', `/api/matches/${ms.id}/status`);
      if (!status) continue;
      if (status.status === 'complete' && status.result) {
        completeMatch(status.my_score ?? 0, status.opp_score ?? 0, matchId);
      }
    } catch (err) {
      if (err?.status === 404) {
        const isActive = STATE.currentMatchId === matchId;
        _removeActiveMatch(matchId);
        if (isActive && STATE.currentScene === 'challenge') {
          showToast('Match is no longer available', 'info');
          const remaining = Object.keys(STATE.activeMatches);
          remaining.length > 0
            ? switchToMatch(remaining[remaining.length - 1])
            : showScene('list-challenge');
        }
      }
    }
  }
}

// ── Server-authoritative match restore on page load ───────────────────────────

async function restoreActiveMatchesFromServer() {
  let serverMatches = [];
  try { serverMatches = await api('GET', '/api/matches/mine/active') || []; } catch {}

  // Load locally-saved arrow progress
  const savedLocal = {};
  try {
    const raw = localStorage.getItem('arrowmatch_active_matches');
    if (raw) {
      for (const [id, ms] of Object.entries(JSON.parse(raw))) {
        if (!ms.complete) savedLocal[id] = ms;
      }
    }
  } catch {}

  for (const sm of serverMatches) {
    const local = savedLocal[sm.match_id] || {};
    STATE.activeMatches[sm.match_id] = {
      id:             sm.match_id,
      challengeId:    sm.challenge_id,
      myName:         STATE.profile?.name || 'You',
      oppName:        sm.opponent_name,
      scoring:        sm.scoring,
      arrowCount:     sm.arrow_count || 18,
      dist:           sm.distance,
      isBot:          false,
      isCreator:      sm.is_creator,
      complete:       false,
      arrowValues:    local.arrowValues    || [],
      setArrowValues: local.setArrowValues || [],
      setMyScore:     local.setMyScore     || 0,
      setOppScore:    local.setOppScore    || 0,
      currentSet:     local.currentSet     || 1,
    };
    connectMatchSocket(sm.match_id);
  }

  // Also pick up local/bot matches from localStorage
  for (const [id, ms] of Object.entries(savedLocal)) {
    if (!STATE.activeMatches[id] && !ms.complete) {
      STATE.activeMatches[id] = ms;
    }
  }

  const restoredCount = serverMatches.length;

  if (restoredCount > 0 || Object.keys(STATE.activeMatches).length > 0) {
    const ids = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = ids[ids.length - 1];
    _updateResumeTab();

    if (restoredCount > 0) {
      showToast(`${restoredCount} active match${restoredCount > 1 ? 'es' : ''} restored`, 'info');
      _startBgStatusPoll();
    }

    restoreMatch();
    showScene('challenge');
  } else {
    showScene('list-challenge');
  }
}

// ── EventBus subscriptions — react to server push events ─────────────────────

// Opponent joined this creator's challenge (from either wait socket or match socket)
EventBus.on(EVENT_TYPES.WS_OPPONENT_JOINED, (payload) => {
  const { challengeId, match_id: realMatchId, opponent_name, matchId } = payload;
  const lookupId = challengeId || matchId;
  const ms       = STATE.activeMatches[lookupId];
  if (!ms) return;

  ms._opponentJoined = true;
  if (_botFallbackTimers[lookupId]) {
    clearTimeout(_botFallbackTimers[lookupId]);
    delete _botFallbackTimers[lookupId];
  }

  if (realMatchId && realMatchId !== lookupId) {
    ms.id      = realMatchId;
    ms.oppName = opponent_name || ms.oppName;
    STATE.activeMatches[realMatchId] = ms;
    delete STATE.activeMatches[lookupId];
    if (STATE.currentMatchId === lookupId) STATE.currentMatchId = realMatchId;
    saveMatchState();
    connectMatchSocket(realMatchId);
    _startBgStatusPoll();
  }

  const isActive = STATE.currentMatchId === (realMatchId || lookupId);
  if (isActive) {
    const oppEl = document.getElementById('ch-opp-name');
    if (oppEl) oppEl.textContent = opponent_name || ms.oppName;
    showToast(`${opponent_name} joined your challenge!`, 'success');
    renderMatchScene();
  }
});

// Opponent forfeited
EventBus.on(EVENT_TYPES.WS_OPPONENT_FORFEITED, ({ matchId }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (isActive) {
    showToast(`${ms?.oppName || 'Opponent'} forfeited — you win!`, 'success');
    completeMatch(1, 0, matchId);
  } else if (ms) {
    showToast(`${ms.oppName} forfeited in another match — you win!`, 'success');
    ms.complete      = true;
    ms.myFinalScore  = 1;
    ms.oppFinalScore = 0;
    saveToHistory(ms);
    _removeActiveMatch(matchId);
  }
});

// Opponent disconnected
EventBus.on(EVENT_TYPES.WS_OPPONENT_DISCONNECTED, ({ matchId }) => {
  if (STATE.currentMatchId === matchId) showToast('Opponent disconnected', 'error');
});

// Rematch proposed to us
EventBus.on(EVENT_TYPES.WS_REMATCH_PROPOSED, ({ matchId, proposed_by }) => {
  const ms       = STATE.activeMatches[matchId] || STATE.matchState;
  const isActive = STATE.currentMatchId === matchId;
  if (isActive) {
    _showRematchRequest(matchId, proposed_by || ms?.oppName);
  } else {
    showToast(`${proposed_by || 'Opponent'} wants a rematch!`, 'info');
  }
});

// Our proposed rematch was accepted
EventBus.on(EVENT_TYPES.WS_REMATCH_ACCEPTED, (payload) => {
  const { matchId, ...data } = payload;
  const ms = STATE.activeMatches[matchId] || STATE.matchState;
  document.getElementById('rematch-pending')?.classList.add('hidden');
  _launchRematchMatch({
    new_match_id:     data.match_id,
    new_challenge_id: data.challenge_id,
    opponent_name:    data.opponent_name || ms?.oppName,
    scoring:          data.scoring,
    distance:         data.distance,
    arrow_count:      data.arrow_count,
    match_type:       data.match_type,
  }, ms);
});

// Our proposed rematch was declined
EventBus.on(EVENT_TYPES.WS_REMATCH_DECLINED, ({ matchId, declined_by }) => {
  if (STATE.currentMatchId !== matchId) return;
  const ms = STATE.activeMatches[matchId] || STATE.matchState;
  document.getElementById('rematch-pending')?.classList.add('hidden');
  document.getElementById('complete-actions')?.classList.remove('hidden');
  showToast(`${declined_by || ms?.oppName || 'Opponent'} declined the rematch`, 'info');
});

// WS connection error for a match
EventBus.on(EVENT_TYPES.WS_ERROR, ({ matchId }) => {
  if (matchId !== 'matchmaking' && STATE.currentMatchId === matchId) {
    showToast('Live connection error — continuing offline', 'error');
  }
});

// ── Helpers used by UI panels ─────────────────────────────────────────────────

function _showRematchRequest(matchId, proposerName) {
  const requestEl = document.getElementById('rematch-request');
  const textEl    = document.getElementById('rematch-request-text');
  const actionsEl = document.getElementById('complete-actions');
  if (!requestEl) return;
  if (textEl) textEl.textContent = `${proposerName} wants a rematch!`;
  actionsEl?.classList.add('hidden');
  requestEl.classList.remove('hidden');
}

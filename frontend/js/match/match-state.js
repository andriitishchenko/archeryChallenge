// =============================================
// ARROWMATCH — Match State Manager
// Owns all match state mutations and business logic.
// Reacts to EventBus events; emits APP_* events for UI to react.
// NEVER touches the DOM directly — all UI updates go through EventBus.
//
// Flow:
//   WS event → EventBus → this module → mutates STATE → emits APP event → UI reacts
//
// Depends on: core/state.js, core/api.js, core/utils.js,
//             core/event-bus.js, core/ws.js, match/bot.js
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
  const background = challenge._background || false;

  const newMs = {
    id: matchId,
    challengeId:   challenge.id,
    myName, oppName, scoring, arrowCount, dist,
    isBot:         challenge.isBot || false,
    arrowValues:   [],
    setMyScore:    0, setOppScore: 0, currentSet: 1, setArrowValues: [],
    complete:      false, isCreator,
    _oppSubmitNotified: false,
    _bgNotified:        false,
  };

  STATE.activeMatches[matchId] = newMs;
  if (!background) STATE.currentMatchId = matchId;

  saveMatchState();
  EventBus.emit(EVENT_TYPES.APP_MATCH_STARTED, { matchId, matchState: newMs, background });

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
}

// ── Match restore / switch ────────────────────────────────────────────────────

function switchToMatch(matchId) {
  let ms = STATE.activeMatches[matchId];

  if (!ms) {
    api('GET', '/api/my-challenges').then(data => {
      const challenges = Array.isArray(data) ? data : [];
      const ch = challenges.find(c => c.match_id === matchId);
      if (!ch) { showToast('Match no longer active', 'error'); return; }
      STATE.activeMatches[matchId] = {
        id: matchId, challengeId: ch.id,
        myName: STATE.profile?.name || 'You', oppName: ch.opponent_name || 'Opponent',
        scoring: ch.scoring, arrowCount: ch.arrow_count || 18, dist: ch.distance,
        matchType: ch.match_type, discipline: ch.discipline || 'target',
        isBot: false, isCreator: ch.is_creator ?? true, complete: false, firstToAct: null,
        challengeKind: 'normal', arrowValues: [], setArrowValues: [],
        setMyScore: 0, setOppScore: 0, currentSet: 1,
        _tiebreakRequired: ch.tiebreak_required || false,
        _tiebreakMatchId:  ch.tiebreak_match_id || null,
      };
      switchToMatch(matchId);
    }).catch(() => showToast('Could not resume match', 'error'));
    return;
  }

  if (ms.complete) { showToast('That match has already finished', 'info'); return; }

  // Persist arrow values for the match we're leaving
  const cur = STATE.activeMatches[STATE.currentMatchId];
  if (cur && !cur.complete) {
    cur.arrowValues    = [...arrowValues];
    cur.setArrowValues = cur.scoring === 'sets' ? [...arrowValues] : cur.setArrowValues;
    saveMatchState();
  }

  STATE.currentMatchId = matchId;
  arrowValues          = [...(ms.arrowValues || [])];

  showScene('challenge');
  EventBus.emit(EVENT_TYPES.APP_MATCH_SWITCHED, { matchId, matchState: ms });
}

function _removeActiveMatch(matchId) {
  if (_botFallbackTimers[matchId]) {
    clearTimeout(_botFallbackTimers[matchId]);
    delete _botFallbackTimers[matchId];
  }
  delete STATE.activeMatches[matchId];
  if (STATE.currentMatchId === matchId) {
    const remaining      = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  saveMatchState();
  EventBus.emit(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, {
    activeMatches: STATE.activeMatches, currentMatchId: STATE.currentMatchId,
  });
}

// ── Match completion ──────────────────────────────────────────────────────────

function completeMatch(myScore, oppScore, targetMatchId, result = null, tiebreakArrows = null) {
  const mid = targetMatchId || STATE.currentMatchId;
  const ms  = STATE.activeMatches[mid];
  if (!ms) return;

  const wasDisplayed = (mid === STATE.currentMatchId);

  ms.complete      = true;
  ms.myFinalScore  = myScore;
  ms.oppFinalScore = oppScore;
  ms.result        = result;
  if (tiebreakArrows) ms._tiebreakArrows = tiebreakArrows;

  STATE.lastCompletedMatch = {
    id: ms.id, oppName: ms.oppName, scoring: ms.scoring,
    arrowCount: ms.arrowCount, dist: ms.dist,
    matchType: ms.matchType || 'live', isBot: ms.isBot,
  };

  _removeActiveMatch(mid);
  saveToHistory(ms);

  // Refresh status for remaining background matches
  for (const [id, m] of Object.entries(STATE.activeMatches)) {
    if (!m.complete && !m.isBot && m.id && !m.id.startsWith('local-')) {
      _fetchAndResolveMatch(id);
    }
  }

  EventBus.emit(EVENT_TYPES.APP_MATCH_COMPLETE, {
    matchId: mid, matchState: ms, myScore, oppScore,
    result: ms.result, tiebreakArrows: ms._tiebreakArrows || null, wasDisplayed,
  });
}

// ── Forfeit ───────────────────────────────────────────────────────────────────

async function forfeitMatch() {
  const ms = STATE.matchState;
  if (!ms || ms.complete) return;

  // Two-tap confirmation handled in score-input.js via APP_FORFEIT_CONFIRM event
  EventBus.emit(EVENT_TYPES.APP_FORFEIT_REQUESTED, { matchId: ms.id });
}

// Called by score-input.js after user confirms via the button
async function _executeForfeit() {
  const ms = STATE.matchState;
  if (!ms || ms.complete) return;

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
    EventBus.emit(EVENT_TYPES.APP_FORFEIT_FAILED, {});
  }
}

function _forfeitAndExit(ms) {
  ms.complete = true; ms.myFinalScore = 0; ms.oppFinalScore = 1;
  _removeActiveMatch(ms.id);
  saveToHistory(ms);
  showScene('my-challenges');
}

// ── Rematch ───────────────────────────────────────────────────────────────────

async function proposeRematch() {
  const prev = STATE.lastCompletedMatch;
  if (!prev) { showToast('No completed match found', 'error'); return; }

  if (prev.isBot) { _startBotRematch(prev); return; }

  EventBus.emit(EVENT_TYPES.APP_REMATCH_PENDING, {});

  try {
    const data = await api('POST', `/api/matches/${prev.id}/rematch`);
    if (data?.new_match_id) prev._rematchMatchId = data.new_match_id;
  } catch (e) {
    showToast(e.message || 'Could not propose rematch', 'error');
    EventBus.emit(EVENT_TYPES.APP_REMATCH_PENDING_CANCEL, {});
  }
}

async function acceptRematch() {
  const prev = STATE.lastCompletedMatch;
  if (!prev) { showToast('No completed match found', 'error'); return; }

  const rematchMatchId = prev._rematchMatchId;
  if (!rematchMatchId) { showToast('Rematch match not found', 'error'); return; }

  EventBus.emit(EVENT_TYPES.APP_REMATCH_ACCEPTED_LOCAL, {});
  try {
    const data = await api('POST', `/api/matches/${rematchMatchId}/rematch/accept`);
    if (data?.new_match_id) {
      _launchRematchMatch({
        new_match_id: data.new_match_id, new_challenge_id: data.new_challenge_id,
        opponent_name: data.opponent_name || prev.oppName,
        scoring: data.scoring || prev.scoring, distance: data.distance || prev.dist,
        arrow_count: data.arrow_count || prev.arrowCount,
        match_type: data.match_type || prev.matchType || 'live',
      }, prev);
    }
  } catch (e) {
    showToast(e.message || 'Could not accept rematch', 'error');
    EventBus.emit(EVENT_TYPES.APP_REMATCH_ACCEPTED_FAIL, {});
  }
}

async function declineRematch() {
  const prev = STATE.lastCompletedMatch;
  const rematchMatchId = prev?._rematchMatchId;
  EventBus.emit(EVENT_TYPES.APP_REMATCH_DECLINED_LOCAL, {});
  try {
    if (rematchMatchId) await api('POST', `/api/matches/${rematchMatchId}/rematch/decline`);
    showToast('Rematch declined', 'info');
  } catch {}
}

function _launchRematchMatch(data, prev) {
  EventBus.emit(EVENT_TYPES.APP_REMATCH_OVERLAY_HIDE, {});
  const inActiveMatch = STATE.currentScene === 'challenge'
    && STATE.currentMatchId && STATE.activeMatches[STATE.currentMatchId]
    && !STATE.activeMatches[STATE.currentMatchId].complete;
  startMatch({
    id:         data.new_challenge_id || `rematch-${Date.now()}`,
    matchId:    data.new_match_id,
    name:       data.opponent_name || prev.oppName,
    scoring:    data.scoring       || prev.scoring,
    distance:   data.distance      || prev.dist,
    arrowCount: data.arrow_count   || prev.arrowCount,
    match_type: data.match_type    || 'live',
    _background: inActiveMatch,
  });
}

function _startBotRematch(prev) {
  EventBus.emit(EVENT_TYPES.APP_REMATCH_OVERLAY_HIDE, {});
  startMatch({
    id: `rematch-${Date.now()}`, name: prev.oppName, isBot: true,
    distance: prev.dist, scoring: prev.scoring, arrowCount: prev.arrowCount,
  });
}

// ── Bot fallback ──────────────────────────────────────────────────────────────

function _scheduleBotFallback(challenge) {
  const matchId   = challenge.matchId || challenge.id;
  const BOT_WAIT  = 2 * 60 * 1000;
  const startTime = Date.now();

  if (_botFallbackTimers[matchId]) {
    clearTimeout(_botFallbackTimers[matchId]);
    delete _botFallbackTimers[matchId];
  }

  function updateCountdown() {
    const ms = STATE.activeMatches[matchId];
    if (!ms || ms.complete || ms._opponentJoined) return;
    const elapsed   = Date.now() - startTime;
    const remaining = Math.max(0, Math.ceil((BOT_WAIT - elapsed) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = String(remaining % 60).padStart(2, '0');
    if (STATE.currentMatchId === matchId) {
      EventBus.emit(EVENT_TYPES.APP_OPP_NAME_UPDATE, {
        matchId, name: remaining > 0 ? `Waiting for opponent (${mins}:${secs})` : 'Connecting bot…',
      });
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
    EventBus.emit(EVENT_TYPES.APP_OPP_NAME_UPDATE, { matchId, name: bot.name });
    showToast(`No opponent joined — ${bot.name} is challenging you!`, 'info');
  }, BOT_WAIT);
}

// ── Status fetch (single unified function) ────────────────────────────────────

/**
 * Fetch /api/matches/{id}/status once and resolve if complete.
 * Used both for background matches and as the post-submit poll.
 * Replaces: _fetchMatchStatus (match-state.js) + _fetchAndResolve (total-mode.js).
 */
async function _fetchAndResolveMatch(matchId) {
  const ms = STATE.activeMatches[matchId];
  if (!ms || ms.complete || ms.isBot) return;

  try {
    const status = await api('GET', `/api/matches/${ms.id}/status`);
    if (!status) return;

    const isTiebreak = status.scoring === 'tiebreak';
    const isSets     = status.scoring === 'sets' || ms.scoring === 'sets';
    const isActive   = STATE.currentMatchId === matchId;

    ms._tiebreakRequired = isTiebreak;
    ms.firstToAct        = status.first_to_act || ms.firstToAct;

    // Always sync set-points and current set from server (authoritative)
    if (isSets && !isTiebreak) {
      ms.setMyScore  = status.my_set_points  ?? ms.setMyScore  ?? 0;
      ms.setOppScore = status.opp_set_points ?? ms.setOppScore ?? 0;
      ms.currentSet  = status.current_set    ?? ms.currentSet  ?? 1;
    }

    saveMatchState();

    if (isTiebreak && isActive) {
      ms.arrowCount    = 1;
      ms.arrowValues   = [];
      arrowValues      = [null];
      activeArrowIndex = 0;
      renderMatchScene();
      _setNumpadDisabled(false);
      if (status.opp_submitted) {
        _setStatus(`${escHtml(ms.oppName)} already shot — shoot your arrow!`);
      }
      return;
    }

    if (status.status === 'complete' && status.result) {
      if (isActive) _setStatus('');
      const myFinal  = isSets ? (status.my_set_points  ?? 0) : (ms._totalMyScore ?? status.my_score  ?? 0);
      const oppFinal = isSets ? (status.opp_set_points ?? 0) : (status.opp_score ?? 0);
      const tbArrows = status.tiebreak_my_arrow != null
        ? { my: status.tiebreak_my_arrow, opp: status.tiebreak_opp_arrow } : null;
      completeMatch(myFinal, oppFinal, matchId, status.result, tbArrows);
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

// ── Server-authoritative restore on page load ─────────────────────────────────

async function restoreActiveMatchesFromServer() {
  const savedLocal = {};
  try {
    const raw = localStorage.getItem('arrowmatch_active_matches');
    if (raw) {
      for (const [id, ms] of Object.entries(JSON.parse(raw))) {
        if (!ms.complete) savedLocal[id] = ms;
      }
    }
  } catch {}

  let serverChallenges = [];
  try {
    const data = await api('GET', '/api/my-challenges');
    if (Array.isArray(data)) serverChallenges = data;
  } catch {}

  const serverMatches = serverChallenges.filter(c => c.match_id && !c.rematch_pending);

  STATE.activeMatches = {};
  STATE.myChallenges  = serverChallenges;
  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(serverChallenges));

  for (const ch of serverMatches) {
    const local = savedLocal[ch.match_id] || {};
    STATE.activeMatches[ch.match_id] = {
      id: ch.match_id, challengeId: ch.id,
      myName: STATE.profile?.name || 'You', oppName: ch.opponent_name || 'Opponent',
      scoring: ch.scoring, arrowCount: ch.arrow_count || 18, dist: ch.distance,
      matchType: ch.match_type, discipline: ch.discipline || 'target',
      isBot: false, isCreator: ch.is_creator ?? true, complete: false, firstToAct: null,
      challengeKind: 'normal',
      _tiebreakRequired: ch.tiebreak_required || false,
      _tiebreakMatchId:  ch.tiebreak_match_id || null,
      arrowValues:    local.arrowValues    || [],
      setArrowValues: local.setArrowValues || [],
      setMyScore:     local.setMyScore     || 0,
      setOppScore:    local.setOppScore    || 0,
      currentSet:     local.currentSet     || 1,
      _oppSubmitNotified: false, _bgNotified: false,
    };
  }

  // Keep offline bot matches
  for (const [id, ms] of Object.entries(savedLocal)) {
    if (ms.isBot && !ms.complete && !STATE.activeMatches[id]) {
      STATE.activeMatches[id] = ms;
    }
  }

  saveMatchState();

  const restoredCount = serverMatches.length;
  if (restoredCount > 0 || Object.keys(STATE.activeMatches).length > 0) {
    const ids = Object.keys(STATE.activeMatches);
    STATE.currentMatchId = ids[ids.length - 1];
    EventBus.emit(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, {
      activeMatches: STATE.activeMatches, currentMatchId: STATE.currentMatchId,
    });
    if (restoredCount > 0) {
      showToast(`${restoredCount} active match${restoredCount > 1 ? 'es' : ''} restored`, 'info');
    }
    EventBus.emit(EVENT_TYPES.APP_MATCH_STARTED, {
      matchId: STATE.currentMatchId, matchState: STATE.matchState, restored: true,
    });
    // showScene('challenge') → triggers _refreshMatchScene() which fetches fresh
    // status from server and restores set-points, currentSet, firstToAct before rendering.
    showScene('challenge');
  } else {
    showScene('list-challenge');
  }
}

// ── EventBus subscriptions ────────────────────────────────────────────────────

EventBus.on(EVENT_TYPES.WS_OPPONENT_JOINED, (payload) => {
  const { challengeId, match_id: realMatchId, opponent_name, matchId } = payload;
  const lookupId = challengeId || matchId;
  let ms = STATE.activeMatches[lookupId];

  if (!ms) {
    const ch = STATE.myChallenges.find(c => c.id === lookupId);
    if (ch) {
      ms = {
        id: lookupId, challengeId: lookupId,
        myName: STATE.profile?.name || 'You', oppName: opponent_name || 'Opponent',
        scoring: ch.scoring || 'total', arrowCount: ch.arrow_count || 18,
        dist: ch.distance || '30m', matchType: ch.match_type,
        isBot: false, isCreator: true, complete: false,
        arrowValues: [], setArrowValues: [], setMyScore: 0, setOppScore: 0, currentSet: 1,
        _oppSubmitNotified: false, _bgNotified: false,
      };
      STATE.activeMatches[lookupId] = ms;
    } else { return; }
  }

  ms._opponentJoined = true;
  if (_botFallbackTimers[lookupId]) {
    clearTimeout(_botFallbackTimers[lookupId]);
    delete _botFallbackTimers[lookupId];
  }

  if (realMatchId && realMatchId !== lookupId) {
    ms.id = realMatchId; ms.oppName = opponent_name || ms.oppName;
    STATE.activeMatches[realMatchId] = ms;
    delete STATE.activeMatches[lookupId];
    if (STATE.currentMatchId === lookupId) STATE.currentMatchId = realMatchId;
    saveMatchState();
  }

  const activeMatchId = realMatchId || lookupId;
  showToast(`${opponent_name || 'Opponent'} joined your challenge!`, 'success');
  STATE.currentMatchId = activeMatchId;
  showScene('challenge');
  renderMatchScene();

  EventBus.emit(EVENT_TYPES.APP_OPP_NAME_UPDATE, {
    matchId: activeMatchId, name: opponent_name || ms.oppName,
  });
});

EventBus.on(EVENT_TYPES.WS_OPPONENT_FORFEITED, ({ matchId }) => {
  const ms = STATE.activeMatches[matchId];
  if (STATE.currentMatchId === matchId) {
    showToast(`${ms?.oppName || 'Opponent'} forfeited — you win!`, 'success');
    completeMatch(1, 0, matchId);
  } else if (ms) {
    showToast(`${ms.oppName} forfeited in another match — you win!`, 'success');
    ms.complete = true; ms.myFinalScore = 1; ms.oppFinalScore = 0;
    saveToHistory(ms);
    _removeActiveMatch(matchId);
  }
});

EventBus.on(EVENT_TYPES.WS_OPPONENT_DISCONNECTED, ({ matchId }) => {
  if (STATE.currentMatchId === matchId) showToast('Opponent disconnected', 'error');
});

EventBus.on(EVENT_TYPES.WS_REMATCH_PROPOSED, ({ matchId, proposed_by }) => {
  const prev = STATE.lastCompletedMatch;
  if (prev) prev._rematchMatchId = matchId;
  const onCompleteScreen = !document.getElementById('match-complete')?.classList.contains('hidden');
  if (onCompleteScreen) {
    EventBus.emit(EVENT_TYPES.APP_SHOW_REMATCH_REQUEST, {
      matchId, proposerName: proposed_by || prev?.oppName || 'Opponent',
    });
    return;
  }
  showToast(`${escHtml(proposed_by || 'Opponent')} wants a rematch! Check My Challenges.`, 'info');
});

EventBus.on(EVENT_TYPES.WS_REMATCH_ACCEPTED, (payload) => {
  const { matchId, ...data } = payload;
  const prev = STATE.lastCompletedMatch || {};
  if (STATE.activeMatches[data.match_id]) return; // dedup
  EventBus.emit(EVENT_TYPES.APP_REMATCH_PENDING_CANCEL, {});
  _launchRematchMatch({
    new_match_id: data.match_id, new_challenge_id: data.challenge_id,
    opponent_name: data.opponent_name || prev.oppName,
    scoring: data.scoring || prev.scoring, distance: data.distance || prev.dist,
    arrow_count: data.arrow_count || prev.arrowCount,
    match_type: data.match_type || prev.matchType || 'live',
  }, prev);
});

EventBus.on(EVENT_TYPES.WS_MATCH_READY, (payload) => {
  const prev = STATE.lastCompletedMatch || {};
  if (STATE.activeMatches[payload.matchId]) return; // dedup
  EventBus.emit(EVENT_TYPES.APP_REMATCH_OVERLAY_HIDE, {});
  _launchRematchMatch({
    new_match_id: payload.matchId, new_challenge_id: payload.challengeId,
    opponent_name: payload.opponent_name || prev.oppName,
    scoring: payload.scoring || prev.scoring, distance: payload.distance || prev.dist,
    arrow_count: payload.arrow_count || prev.arrowCount,
    match_type: payload.match_type || prev.matchType || 'live',
  }, prev);
});

EventBus.on(EVENT_TYPES.WS_REMATCH_DECLINED, ({ matchId, declined_by }) => {
  const prev = STATE.lastCompletedMatch || {};
  EventBus.emit(EVENT_TYPES.APP_REMATCH_PENDING_CANCEL, {});
  EventBus.emit(EVENT_TYPES.APP_REMATCH_ACTIONS_SHOW, {});
  showToast(`${escHtml(declined_by || prev.oppName || 'Opponent')} declined the rematch`, 'info');
});

EventBus.on(EVENT_TYPES.WS_ERROR, ({ matchId }) => {
  if (matchId !== 'matchmaking' && STATE.currentMatchId === matchId) {
    showToast('Live connection error — continuing offline', 'error');
  }
});

// Server confirms match is complete
EventBus.on(EVENT_TYPES.WS_MATCH_COMPLETE, ({ matchId }) => {
  _fetchAndResolveMatch(matchId);
});

// Confirm forfeit (fired by score-input.js after button confirm)
EventBus.on(EVENT_TYPES.APP_FORFEIT_CONFIRMED, () => {
  _executeForfeit();
});

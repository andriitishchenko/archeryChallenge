// =============================================
// ARROWMATCH — WebSocket & Matchmaking
// Per-match and matchmaking WebSocket management.
// Depends on: core/state.js, core/api.js, core/utils.js,
//             match/bot.js, match/match-state.js,
//             match/score-input.js, match/set-mode.js, match/total-mode.js
// =============================================

// ── Matchmaking ───────────────────────────────────────────────────────────────

function findOpponent() {
  if (!STATE.profile) { showToast('Complete your profile first', 'error'); showScene('settings'); return; }

  const statusEl = document.getElementById('find-status');
  const btn      = document.querySelector('.find-btn');
  btn.disabled      = true;
  btn.textContent   = 'Searching…';

  _connectMatchmaking(statusEl, btn);
}

function _connectMatchmaking(statusEl, btn) {
  if (mmSocket) { mmSocket.close(); mmSocket = null; }

  try {
    mmSocket = new WebSocket(`${WS_BASE}/ws/matchmaking?token=${STATE.accessToken || ''}`);

    mmSocket.onopen = () => {
      statusEl.innerHTML = `<span class="spinner"></span> Searching for opponent…`;
      mmSocket.send(JSON.stringify({
        type: 'find',
        filters: STATE.filters,
        profile: {
          user_id:     STATE.userId,
          name:        STATE.profile.name,
          gender:      STATE.profile.gender,
          age:         STATE.profile.age,
          bow_type:    STATE.profile.bowType,
          skill_level: STATE.profile.skillLevel,
          country:     STATE.profile.country,
        }
      }));
    };

    mmSocket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        statusEl.innerHTML = `<span class="spinner"></span> ${escHtml(msg.message)}`;
      } else if (msg.type === 'matched') {
        statusEl.textContent = '';
        btn.disabled         = false;
        btn.textContent      = 'Find Opponent';
        mmSocket.close();
        startMatch({
          id:         msg.match_id,
          matchId:    msg.match_id,
          name:       msg.opponent?.name || 'Opponent',
          distance:   STATE.profile.preferredDist || '30m',
          scoring:    'total',
          arrowCount: STATE.arrowCount,
        });
      }
    };

    mmSocket.onerror = () => { _fallbackFindOpponent(statusEl, btn); };
    mmSocket.onclose = (e) => { if (e.code !== 1000) _fallbackFindOpponent(statusEl, btn); };

  } catch {
    _fallbackFindOpponent(statusEl, btn);
  }
}

function _fallbackFindOpponent(statusEl, btn) {
  const messages = [
    'Connecting to matchmaking…',
    'Scanning for opponents…',
    'Applying filters…',
    'Almost there…',
    'Generating bot challenger…',
  ];
  let idx = 0;
  statusEl.innerHTML = `<span class="spinner"></span> ${messages[0]}`;
  const t = setInterval(() => {
    idx++;
    if (idx >= messages.length) {
      clearInterval(t);
      btn.disabled    = false;
      btn.textContent = 'Find Opponent';
      statusEl.textContent = '';
      startMatch(generateBotOpponent());
    } else {
      statusEl.innerHTML = `<span class="spinner"></span> ${messages[idx]}`;
    }
  }, 900);
}

// ── Bot countdown ─────────────────────────────────────────────────────────────

function _scheduleBotFallback(challenge) {
  const matchId    = challenge.matchId || challenge.id;
  const BOT_WAIT_MS = 2 * 60 * 1000;
  const startTime  = Date.now();

  if (_botFallbackTimers[matchId]) {
    clearTimeout(_botFallbackTimers[matchId]);
    delete _botFallbackTimers[matchId];
  }

  function updateCountdown() {
    const targetMs = STATE.activeMatches[matchId];
    if (!targetMs || targetMs.complete || targetMs._opponentJoined) return;
    const elapsed   = Date.now() - startTime;
    const remaining = Math.max(0, Math.ceil((BOT_WAIT_MS - elapsed) / 1000));
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
    const targetMs = STATE.activeMatches[matchId];
    if (!targetMs || targetMs.complete || targetMs._opponentJoined) return;

    const bot      = generateBotOpponent();
    bot.distance   = challenge.distance    || targetMs.dist       || '30m';
    bot.scoring    = challenge.scoring     || targetMs.scoring    || 'total';
    bot.arrowCount = challenge.arrow_count || targetMs.arrowCount || 18;

    targetMs.oppName = bot.name;
    targetMs.isBot   = true;
    saveMatchState();

    if (STATE.currentMatchId === matchId) {
      const oppEl = document.getElementById('ch-opp-name');
      if (oppEl) oppEl.textContent = bot.name;
    }
    showToast(`No opponent joined — ${bot.name} is challenging you!`, 'info');
  }, BOT_WAIT_MS);
}

// ── Per-match WebSocket ───────────────────────────────────────────────────────

function _connectMatchSocket(matchId) {
  if (matchSockets[matchId]) { matchSockets[matchId].close(); delete matchSockets[matchId]; }

  try {
    const ws = new WebSocket(`${WS_BASE}/ws/match/${matchId}?token=${STATE.accessToken || ''}`);
    matchSockets[matchId] = ws;

    ws.onopen = () => {
      ws._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      const targetMs = STATE.activeMatches[matchId];
      if (!targetMs) return;

      // Any real message means opponent connected — cancel bot fallback
      if (!targetMs.isBot) {
        targetMs._opponentJoined = true;
        if (_botFallbackTimers[matchId]) {
          clearTimeout(_botFallbackTimers[matchId]);
          delete _botFallbackTimers[matchId];
        }
        if (STATE.currentMatchId === matchId) {
          const oppEl = document.getElementById('ch-opp-name');
          if (oppEl && (oppEl.textContent.startsWith('Waiting') || oppEl.textContent.startsWith('Connecting'))) {
            oppEl.textContent = targetMs.oppName;
          }
        }
      }

      const isActive = STATE.currentMatchId === matchId;

      switch (msg.type) {
        case 'opponent_joined': {
          // Server sends this to the creator when someone joins their challenge.
          // msg.match_id = the newly-created server match UUID.
          // msg.opponent_name = joiner's display name.
          const realMatchId   = msg.match_id;
          const opponentName  = msg.opponent_name || targetMs.oppName;

          // Cancel bot fallback — a real human joined
          targetMs._opponentJoined = true;
          if (_botFallbackTimers[matchId]) {
            clearTimeout(_botFallbackTimers[matchId]);
            delete _botFallbackTimers[matchId];
          }

          // Migrate match state to the real server match_id
          if (realMatchId && realMatchId !== matchId) {
            targetMs.id      = realMatchId;
            targetMs.oppName = opponentName;
            // Re-key in activeMatches map
            STATE.activeMatches[realMatchId] = targetMs;
            delete STATE.activeMatches[matchId];
            if (STATE.currentMatchId === matchId) STATE.currentMatchId = realMatchId;

            // Close old socket (registered under challengeId), open new one on realMatchId
            ws.close();
            _connectMatchSocket(realMatchId);
            saveMatchState();
          }

          if (isActive || STATE.currentMatchId === realMatchId) {
            const oppEl = document.getElementById('ch-opp-name');
            if (oppEl) oppEl.textContent = opponentName;
            showToast(`${opponentName} joined your challenge!`, 'success');
          }
          break;
        }

        case 'opp_arrow':
          if (isActive) _onOpponentArrow(msg.arrow_index, msg.value);
          break;

        case 'opp_set_done': {
          if (targetMs._pendingSetNumber !== undefined) {
            const pendingSet = targetMs._pendingSetNumber;
            delete targetMs._pendingSetNumber;
            const prevId = STATE.currentMatchId;
            STATE.currentMatchId = matchId;
            api('POST', `/api/matches/${matchId}/set`, {
              set_number: pendingSet,
              arrows:     targetMs.setArrowValues || [],
            }).then(result => {
              if (result) _applySetResult(result, matchId);
              STATE.currentMatchId = prevId;
            });
          } else if (isActive) {
            showToast(`${targetMs.oppName} submitted their set`, 'info');
          }
          break;
        }

        case 'opp_tiebreak_done': {
          if (targetMs._pendingTiebreak) {
            delete targetMs._pendingTiebreak;
            const prevId  = STATE.currentMatchId;
            STATE.currentMatchId = matchId;
            const myArrow = isActive ? arrowValues[0] : null;
            if (myArrow !== null) {
              api('POST', `/api/matches/${matchId}/set`, {
                set_number: 0, arrows: [myArrow],
              }).then(result => {
                STATE.currentMatchId = prevId;
                if (!result) return;
                if (isActive) {
                  if (result.tiebreak_required) {
                    showToast('Still tied! Shoot one more.', 'info');
                    arrowValues = [null]; activeArrowIndex = 0;
                    refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
                  } else if (result.match_complete) {
                    _setStatus('');
                    completeMatch(result.my_set_points, result.opp_set_points, matchId);
                  }
                }
              });
            } else {
              STATE.currentMatchId = prevId;
            }
          }
          break;
        }

        case 'opp_score_done':
          if (isActive && targetMs._polling) {
            clearInterval(_pollInterval);
            _pollInterval = null;
            _pollForResult();
          } else if (!isActive) {
            showToast(`${targetMs.oppName} submitted their score in another match!`, 'info');
          }
          break;

        case 'opponent_forfeited':
          if (isActive) {
            showToast(`${targetMs.oppName} forfeited — you win!`, 'success');
            completeMatch(1, 0, matchId);
          } else {
            showToast(`${targetMs.oppName} forfeited in another match — you win!`, 'success');
            targetMs.complete      = true;
            targetMs.myFinalScore  = 1;
            targetMs.oppFinalScore = 0;
            saveToHistory(targetMs);
            _removeActiveMatch(matchId);
          }
          break;

        case 'opponent_disconnected':
          if (isActive) showToast('Opponent disconnected', 'error');
          break;

        case 'pong':
          break;
      }
    };

    ws.onerror = () => {
      if (STATE.currentMatchId === matchId) showToast('Live connection error — continuing offline', 'error');
    };

    ws.onclose = () => {
      if (ws._pingTimer) clearInterval(ws._pingTimer);
    };

  } catch (err) {
    console.warn('WebSocket unavailable for live match:', err);
  }
}

// ── Opponent UI helpers (called from WS handler) ──────────────────────────────

function _onOpponentArrow(arrowIndex, value) {
  const ms = STATE.matchState;
  if (!ms || ms.scoring !== 'total') return;
  const indicator = document.getElementById('opp-live-indicator');
  if (!indicator) return;
  indicator.classList.remove('hidden');
  indicator.classList.add('active');
  indicator.textContent = `${ms.oppName}: arrow ${arrowIndex + 1} → ${value}`;
  clearTimeout(indicator._hideTimer);
  indicator._hideTimer = setTimeout(() => {
    indicator.classList.remove('active');
    indicator.textContent = `${ms.oppName} is shooting…`;
  }, 2500);
}

function _onOpponentRowComplete(row, rowTotal, arrows) {
  const ms = STATE.matchState;
  if (!ms) return;
  showToast(`${ms.oppName}: row ${row + 1} = ${rowTotal}`, 'info');
  const indicator = document.getElementById('opp-live-indicator');
  if (indicator) {
    indicator.classList.remove('hidden');
    indicator.textContent = `${ms.oppName} row ${row + 1}: ${arrows.join('  ')} = ${rowTotal}`;
  }
}

function _showOppSetArrows(oppTotal, arrows) {
  const ms        = STATE.matchState;
  const indicator = document.getElementById('opp-live-indicator');
  if (!indicator) return;
  indicator.classList.remove('hidden');
  const arrowStr = arrows.length ? arrows.join(' ') + ' = ' : '';
  indicator.textContent = `${ms?.oppName || 'Opp'}: ${arrowStr}${oppTotal} pts`;
  clearTimeout(indicator._hideTimer);
  indicator._hideTimer = setTimeout(() => indicator.classList.add('hidden'), 3500);
}

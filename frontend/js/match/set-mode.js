// =============================================
// ARROWMATCH — Set-System Mode
// Each set: 3 arrows → server decides winner → next set or tiebreak.
// Reacts to WS_OPP_SET_DONE and WS_OPP_TIEBREAK_DONE via EventBus.
// Never calls WebSocket methods directly.
//
// Depends on: core/state.js, core/api.js, core/event-bus.js,
//             match/match-state.js, match/score-input.js, match/bot.js,
//             match/ws-manager.js
// =============================================

// ── EventBus subscriptions ────────────────────────────────────────────────────

// Opponent finished their set arrows — resolve if we already submitted
EventBus.on(EVENT_TYPES.WS_OPP_SET_DONE, ({ matchId }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms) return;

  if (ms._pendingSetNumber !== undefined) {
    // We already submitted; server was waiting for opponent — resolve now
    const pendingSet = ms._pendingSetNumber;
    delete ms._pendingSetNumber;

    const prevId = STATE.currentMatchId;
    STATE.currentMatchId = matchId;

    api('POST', `/api/matches/${matchId}/set`, {
      set_number: pendingSet,
      arrows:     ms.setArrowValues || [],
    }).then(result => {
      if (result) _applySetResult(result, matchId);
      STATE.currentMatchId = prevId;
    });
  } else if (isActive) {
    showToast(`${ms.oppName} submitted their set`, 'info');
  }
});

// Opponent finished their tiebreak arrow
EventBus.on(EVENT_TYPES.WS_OPP_TIEBREAK_DONE, ({ matchId }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms || !ms._pendingTiebreak) return;

  delete ms._pendingTiebreak;

  const prevId  = STATE.currentMatchId;
  STATE.currentMatchId = matchId;
  const myArrow = isActive ? arrowValues[0] : null;

  if (myArrow !== null) {
    api('POST', `/api/matches/${matchId}/set`, {
      set_number: 0,
      arrows:     [myArrow],
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
});

// ── Set resolution ────────────────────────────────────────────────────────────

async function resolveSet() {
  const ms = STATE.matchState;
  if (!ms || ms._setSubmitting) return;
  ms._setSubmitting = true;

  const myArrows  = arrowValues.filter(v => v !== null);
  const myTotal   = myArrows.reduce((a, b) => a + b, 0);
  const setNumber = ms.currentSet;

  _setNumpadDisabled(true);
  _setStatus(`Set ${setNumber}: waiting for opponent…`);

  // Notify opponent we submitted
  sendMatchMessage({ type: 'set_submitted', set_number: setNumber });

  if (ms.isBot) {
    const botArrows = _genBotArrows(ms.oppSkill || 'Skilled');
    const botTotal  = botArrows.reduce((a, b) => a + b, 0);
    _resolveSetLocally(myTotal, botTotal, setNumber, ms);
    ms._setSubmitting = false;
    return;
  }

  try {
    const result = await api('POST', `/api/matches/${ms.id}/set`, {
      set_number: setNumber,
      arrows:     myArrows,
    });
    ms._setSubmitting = false;
    _applySetResult(result);
  } catch {
    showToast('Network error — retrying…', 'error');
    ms._setSubmitting = false;
    _setNumpadDisabled(false);
    _setStatus('');
  }
}

function _resolveSetLocally(myTotal, oppTotal, setNumber, ms) {
  let myPts = 0, oppPts = 0, winner;
  if (myTotal > oppTotal)      { myPts = 2; winner = 'me'; }
  else if (oppTotal > myTotal) { oppPts = 2; winner = 'opponent'; }
  else                          { myPts = 1; oppPts = 1; winner = 'draw'; }

  ms.setMyScore  += myPts;
  ms.setOppScore += oppPts;
  ms.currentSet++;
  refreshSetScore();

  const label = winner === 'me'       ? '✓ You win this set!'
              : winner === 'opponent' ? `${ms.oppName} wins this set`
              :                         'Set draw — 1 pt each';
  showToast(`Set ${setNumber}: ${myTotal} vs ${oppTotal} — ${label}`,
    winner === 'me' ? 'success' : 'info');

  if (ms.setMyScore >= 6 || ms.setOppScore >= 6) {
    if (ms.setMyScore === 6 && ms.setOppScore === 6) _startTiebreak();
    else completeMatch(ms.setMyScore, ms.setOppScore, ms.id);
  } else {
    _nextSet(setNumber);
  }
  saveMatchState();
}

function _applySetResult(result, targetMatchId) {
  const mid      = targetMatchId || STATE.currentMatchId;
  const ms       = STATE.activeMatches[mid];
  if (!ms) return;
  const isActive = mid === STATE.currentMatchId;

  if (!result.both_submitted) {
    ms._pendingSetNumber = result.set_number;
    if (isActive) _setStatus(`Set ${result.set_number}: your arrows recorded. Waiting for ${ms.oppName}…`);
    return;
  }

  const setNumber    = result.set_number;
  ms.setMyScore      = result.my_set_points;
  ms.setOppScore     = result.opp_set_points;
  ms.currentSet      = setNumber + 1;

  const winner = result.set_winner;
  const label  = winner === 'me'       ? '✓ You win this set!'
               : winner === 'opponent' ? `${ms.oppName} wins this set`
               :                         'Set draw — 1 pt each';
  showToast(`Set ${setNumber}: ${result.my_set_total} vs ${result.opp_set_total} — ${label}`,
    winner === 'me' ? 'success' : 'info');

  if (isActive) {
    refreshSetScore();
    _showOppSetArrows(result.opp_set_total, []);
    if      (result.tiebreak_required) _startTiebreak();
    else if (result.match_complete)    completeMatch(ms.setMyScore, ms.setOppScore, mid);
    else                               _nextSet(setNumber);
  } else if (result.match_complete) {
    completeMatch(ms.setMyScore, ms.setOppScore, mid);
  }
  saveMatchState();
}

function _nextSet(prevSetNumber) {
  const ms = STATE.matchState;
  arrowValues       = new Array(3).fill(null);
  ms.setArrowValues = [];
  activeArrowIndex  = 0;
  buildSetArrowRow();
  refreshSetArrowCells();
  _setNumpadDisabled(false);
  _setStatus('');
  document.getElementById('set-progress').textContent = `Set ${ms.currentSet}`;
}

function _startTiebreak() {
  const ms = STATE.matchState;
  ms._tiebreak      = true;
  arrowValues       = [null];
  ms.setArrowValues = [];
  activeArrowIndex  = 0;
  buildSetArrowRow(1);
  refreshSetArrowCells();
  _setNumpadDisabled(false);
  _setStatus('');
  document.getElementById('set-progress').textContent = 'Tiebreak — sudden death';
  showToast('Tied at 6:6! One arrow decides — highest score wins.', 'info');
  saveMatchState();
}

async function resolveTiebreak() {
  const ms      = STATE.matchState;
  const myArrow = arrowValues[0];
  if (myArrow === null) return;

  _setNumpadDisabled(true);
  _setStatus('Tiebreak: waiting for opponent…');

  sendMatchMessage({ type: 'tiebreak_submitted', set_number: 0 });

  if (ms.isBot) {
    const botArrow = Math.floor(Math.random() * 11);
    if (myArrow === botArrow) {
      showToast(`Both shot ${myArrow}! Shoot again.`, 'info');
      arrowValues = [null]; activeArrowIndex = 0;
      refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
      return;
    }
    let myScore = ms.setMyScore, oppScore = ms.setOppScore;
    if (myArrow > botArrow) myScore  += 2;
    else                    oppScore += 2;
    completeMatch(myScore, oppScore, ms.id);
    return;
  }

  try {
    const result = await api('POST', `/api/matches/${ms.id}/set`, {
      set_number: 0,
      arrows:     [myArrow],
    });
    if (!result.both_submitted) {
      _setStatus(`Tiebreak: waiting for ${ms.oppName}…`);
      ms._pendingTiebreak = true;
      return;
    }
    if (result.tiebreak_required) {
      showToast('Both shot equal! Shoot one more arrow.', 'info');
      arrowValues = [null]; activeArrowIndex = 0;
      refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
      return;
    }
    _setStatus('');
    completeMatch(result.my_set_points, result.opp_set_points, ms.id);
  } catch {
    showToast('Network error on tiebreak', 'error');
    _setNumpadDisabled(false);
    _setStatus('');
  }
}

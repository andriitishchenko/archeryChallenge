// =============================================
// ARROWMATCH — Set-System Mode
// 3 arrows per set → server decides winner → next set or tiebreak.
//
// Depends on: core/state.js, core/api.js, core/event-bus.js,
//             match/match-state.js, match/score-input.js, match/bot.js
// =============================================

// Opponent finished their set — resolve if we already submitted
EventBus.on(EVENT_TYPES.WS_OPP_SET_DONE, ({ matchId, set_number, set_total }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms) return;

  if (ms._pendingSetNumber !== undefined) {
    if (ms.complete) { delete ms._pendingSetNumber; return; }
    const pendingSet = ms._pendingSetNumber;
    delete ms._pendingSetNumber;
    const prevId = STATE.currentMatchId;
    STATE.currentMatchId = matchId;
    api('POST', `/api/matches/${matchId}/set`, {
      set_number: pendingSet, arrows: ms.setArrowValues || [],
    }).then(result => {
      if (result) _applySetResult(result, matchId);
      STATE.currentMatchId = prevId;
    }).catch(() => { STATE.currentMatchId = prevId; });
  } else if (isActive) {
    const totalStr = set_total !== undefined ? ` (${set_total} pts)` : '';
    _setStatus(`${escHtml(ms.oppName)} submitted set ${set_number || ''}${totalStr} — waiting for your arrows…`);
  }
});

// Live scoreboard update when both players submitted a set
EventBus.on(EVENT_TYPES.WS_SET_RESOLVED, ({ matchId, set_number, scores, winner_id, next_first }) => {
  const ms       = STATE.activeMatches[matchId];
  const isActive = STATE.currentMatchId === matchId;
  if (!ms || !scores) return;

  const myId    = STATE.userId;
  const myData  = scores[myId]  || { total: 0, pts: 0 };
  const oppId   = Object.keys(scores).find(id => id !== myId);
  const oppData = oppId ? (scores[oppId] || { total: 0, pts: 0 }) : { total: 0, pts: 0 };

  ms.setMyScore = myData.pts;
  ms.setOppScore = oppData.pts;
  ms.currentSet  = set_number + 1;
  ms.firstToAct  = next_first;
  saveMatchState();

  if (isActive) {
    refreshSetScore();
    _showOppSetArrows(oppData.total, []);
    const youWon  = winner_id === myId;
    const oppWon  = winner_id && winner_id !== myId;
    const label   = youWon ? 'You win this set!'
                  : oppWon ? `${escHtml(ms.oppName)} wins this set`
                  :           'Set drawn — 1 pt each';
    const youFirst = next_first === myId;
    const nextMsg  = youFirst
      ? 'You shoot first next set.'
      : `${escHtml(ms.oppName)} shoots first next set.`;
    _setStatus(`Set ${set_number}: ${myData.total}–${oppData.total} — ${label}  [${myData.pts}:${oppData.pts}]  ${nextMsg}`);
    // Brief pause so player reads the result before cells reset
    setTimeout(() => _nextSet(set_number), 1500);
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
    api('POST', `/api/matches/${matchId}/set`, { set_number: 0, arrows: [myArrow] })
      .then(result => {
        STATE.currentMatchId = prevId;
        if (!result) return;
        if (result.tiebreak_required) {
          showToast('Still tied! Shoot one more.', 'info');
          arrowValues = [null]; activeArrowIndex = 0;
          refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
        } else if (result.match_complete) {
          _setStatus('');
          completeMatch(result.my_set_points, result.opp_set_points, matchId, result.match_result ?? null);
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
  if (ms.id === ms.challengeId) {
    _setStatus('Waiting for opponent to join before you can submit…');
    return;
  }

  ms._setSubmitting = true;
  const myArrows  = arrowValues.filter(v => v !== null);

  // Guard: all arrows must be filled before submitting
  if (myArrows.length === 0 || myArrows.length < arrowValues.length) {
    ms._setSubmitting = false;
    return;
  }

  const myTotal   = myArrows.reduce((a, b) => a + b, 0);
  const setNumber = ms.currentSet;

  _setNumpadDisabled(true);
  _setStatus(`Set ${setNumber}: waiting for opponent…`);

  if (ms.isBot) {
    const botArrows = genBotArrows(ms.oppSkill || 'Skilled');
    const botTotal  = botArrows.reduce((a, b) => a + b, 0);
    _resolveSetLocally(myTotal, botTotal, setNumber, ms);
    ms._setSubmitting = false;
    return;
  }

  try {
    const result = await api('POST', `/api/matches/${ms.id}/set`, {
      set_number: setNumber, arrows: myArrows,
    });
    ms._setSubmitting = false;
    _applySetResult(result);
  } catch (e) {
    if (e?.status === 404) {
      ms._setSubmitting = false;
      _setNumpadDisabled(true);
      _setStatus('This match is no longer available.');
      return;
    }
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
    if (isActive) {
      // Clear cells and lock numpad — wait for opponent's WS_OPP_SET_DONE
      arrowValues       = new Array(arrowValues.length || 3).fill(null);
      ms.setArrowValues = [];
      activeArrowIndex  = 0;
      buildSetArrowRow();
      refreshSetArrowCells();
      _setNumpadDisabled(true);
      _setStatus(result.judge_status || `Set ${result.set_number}: your arrows recorded. Waiting for ${ms.oppName}…`);
    }
    return;
  }

  const setNumber    = result.set_number;
  ms.setMyScore      = result.my_set_points;
  ms.setOppScore     = result.opp_set_points;
  ms.currentSet      = setNumber + 1;
  if (result.next_first_to_act) ms.firstToAct = result.next_first_to_act;

  const myName  = ms.myName  || STATE.profile?.name || 'You';
  const oppName = ms.oppName || 'Opponent';
  const winner  = result.set_winner;
  const label   = winner === 'me'       ? `${myName} wins this set!`
                : winner === 'opponent' ? `${oppName} wins this set`
                :                         'Set drawn — 1 pt each';
  showToast(`Set ${setNumber}: ${myName} ${result.my_set_total} – ${oppName} ${result.opp_set_total} — ${label}`,
    winner === 'me' ? 'success' : 'info');

  if (isActive) {
    refreshSetScore();
    _showOppSetArrows(result.opp_set_total, []);
    if (!result.match_complete && !result.tiebreak_required) {
      const youFirst = result.next_first_to_act === STATE.userId;
      const nextMsg  = youFirst ? 'You shoot first next set.' : `${oppName} shoots first next set.`;
      _setStatus(`Set ${setNumber}: ${myName} ${result.my_set_total} – ${oppName} ${result.opp_set_total} — ${label}  [${result.my_set_points}:${result.opp_set_points}]  ${nextMsg}`);
    }
    if      (result.tiebreak_required) _startTiebreak();
    else if (result.match_complete)    completeMatch(ms.setMyScore, ms.setOppScore, mid, result.match_result ?? null);
    else                               _nextSet(setNumber);
  } else if (result.match_complete) {
    completeMatch(ms.setMyScore, ms.setOppScore, mid, result.match_result ?? null);
  }
  saveMatchState();
}

function _nextSet(prevSetNumber) {
  const ms = STATE.matchState;
  arrowValues       = new Array(3).fill(null);
  ms.setArrowValues = [];
  ms._oppSetArrows  = [];   // reset live opponent arrows for new set
  activeArrowIndex  = 0;
  buildSetArrowRow();
  refreshSetArrowCells();
  _setNumpadDisabled(false);
  _oppIndicatorHide();  // clear previous set's indicator
  document.getElementById('set-progress').textContent = `Set ${ms.currentSet}`;
  if (ms.firstToAct) {
    const youFirst = ms.firstToAct === STATE.userId;
    _setStatus(youFirst
      ? `Set ${ms.currentSet}: you shoot first. [${ms.setMyScore}:${ms.setOppScore}]`
      : `Set ${ms.currentSet}: ${escHtml(ms.oppName)} shoots first. [${ms.setMyScore}:${ms.setOppScore}]`);
  } else {
    _setStatus('');
  }
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

  if (ms.isBot) {
    const botArrow = Math.floor(Math.random() * 11);
    if (myArrow === botArrow) {
      showToast(`Both shot ${myArrow}! Shoot again.`, 'info');
      arrowValues = [null]; activeArrowIndex = 0;
      refreshSetArrowCells(); _setNumpadDisabled(false); _setStatus('');
      return;
    }
    const myWins = myArrow > botArrow;
    completeMatch(
      ms.setMyScore  + (myWins  ? 2 : 0),
      ms.setOppScore + (!myWins ? 2 : 0),
      ms.id,
    );
    return;
  }

  try {
    const result = await api('POST', `/api/matches/${ms.id}/set`, {
      set_number: 0, arrows: [myArrow],
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
    completeMatch(result.my_set_points, result.opp_set_points, ms.id, result.match_result ?? null);
  } catch (e) {
    if (e?.status === 404) {
      _setNumpadDisabled(true);
      _setStatus('This match is no longer available.');
      return;
    }
    showToast('Network error on tiebreak', 'error');
    _setNumpadDisabled(false);
    _setStatus('');
  }
}

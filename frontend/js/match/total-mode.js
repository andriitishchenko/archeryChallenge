// =============================================
// ARROWMATCH — Total-Score Mode
// Enter all arrows → submit → wait for opponent result.
// Uses _fetchAndResolveMatch() from match-state.js (unified status fetch).
//
// Depends on: core/state.js, core/api.js, core/event-bus.js,
//             match/match-state.js, match/score-input.js, match/bot.js
// =============================================

// Opponent submitted their total score (match socket)
EventBus.on(EVENT_TYPES.WS_OPP_SCORE_DONE, ({ matchId }) => {
  const ms = STATE.activeMatches[matchId];
  if (!ms) return;
  if (STATE.currentMatchId === matchId) {
    _setStatus(`${escHtml(ms.oppName)} submitted their score — calculating result…`);
  }
  _fetchAndResolveMatch(matchId);
});

// Out-of-band: opponent submitted in any match (user socket)
EventBus.on(EVENT_TYPES.WS_OPP_SCORE_SUBMITTED, ({ matchId, opponent_name }) => {
  const ms = STATE.activeMatches[matchId];
  if (!ms || ms._oppSubmitNotified) return;
  ms._oppSubmitNotified = true;
  if (STATE.currentMatchId === matchId) {
    _setStatus(`${escHtml(opponent_name || ms.oppName)} submitted their score — calculating result…`);
  }
  _fetchAndResolveMatch(matchId);
});

// tiebreak_started fires both on first tiebreak AND on reset (equal scores again)
EventBus.on(EVENT_TYPES.WS_TIEBREAK_STARTED, ({ matchId: tbMatchId, parentMatchId }) => {
  const matchId = parentMatchId || tbMatchId;
  const ms = STATE.activeMatches[matchId];
  if (!ms || STATE.currentMatchId !== matchId) return;

  ms._totalSubmitting   = false;
  ms._oppSubmitNotified = false;
  ms._tiebreakRequired  = true;
  ms._tiebreakSubmitted = false;
  ms._tiebreakMatchId   = tbMatchId;
  arrowValues           = [null];
  activeArrowIndex      = 0;

  saveMatchState();
  renderMatchScene();
  _setNumpadDisabled(false);
  _setStatus('');
  showToast('Sudden death — shoot one arrow!', 'info');
});

// ── Total-score submission ────────────────────────────────────────────────────

async function checkTotalComplete() {
  const ms    = STATE.matchState;
  const count = ms._tiebreakRequired ? 1 : ms.arrowCount;
  if (!arrowValues.slice(0, count).every(v => v !== null)) return;
  if (ms._totalSubmitting) return;

  const myScore = arrowValues.slice(0, count).reduce((a, b) => a + b, 0);
  _setNumpadDisabled(true);
  ms._totalSubmitting = true;

  if (ms.isBot) {
    const botScore = genBotTotal(myScore, ms.oppSkill || 'Skilled');
    if (myScore === botScore) { _doBotTiebreak(myScore); }
    else                      { completeMatch(myScore, botScore, ms.id); }
    return;
  }

  const result = await _submitScoreToServer(arrowValues.slice(0, count));
  if (!result) { ms._totalSubmitting = false; _setNumpadDisabled(false); return; }

  if (result.scoring === 'tiebreak' || result.tiebreak_required) {
    // Main score tied — tiebreak match created. Player has NOT yet shot tiebreak arrow.
    ms._totalSubmitting   = false;
    ms._tiebreakRequired  = true;
    ms._tiebreakSubmitted = false;  // player still needs to shoot
    ms._tiebreakMatchId   = result.tiebreak_match_id || null;
    ms._totalMyScore      = myScore;
    // Reset to 1-arrow tiebreak input
    arrowValues       = [null];
    activeArrowIndex  = 0;
    saveMatchState();
    renderMatchScene();   // switches UI to 1-arrow mode
    _setNumpadDisabled(false);
    _setStatus('Tied! Sudden death — shoot one arrow. Highest wins.');
    showToast('Sudden death — shoot one arrow!', 'info');
    return;
  }

  if (result.match_complete) {
    _setStatus('');
    return; // APP_MATCH_COMPLETE fires via WS_MATCH_COMPLETE → _fetchAndResolveMatch
  }

  _setStatus(`Score submitted (${myScore}). Waiting for ${escHtml(ms.oppName)}…`);
  ms._totalMyScore = myScore;
}

// ── Bot tiebreak ──────────────────────────────────────────────────────────────

function _doBotTiebreak(baseScore) {
  const ms = STATE.matchState;
  if (!ms) return;

  const myArrow  = Math.floor(Math.random() * 11);
  const botArrow = Math.floor(Math.random() * 11);

  if (myArrow === botArrow) {
    showToast('Both shot ' + myArrow + '! Shoot one more.', 'info');
    arrowValues = [null]; activeArrowIndex = 0;
    buildArrowRows(1);
    refreshArrowCells();
    _setNumpadDisabled(false);
    _setStatus('Tiebreak — sudden death! One arrow each.');
    return;
  }

  const myWins   = myArrow > botArrow;
  const myFinal  = baseScore + (myWins  ? 1 : 0);
  const oppFinal = baseScore + (!myWins ? 1 : 0);
  completeMatch(myFinal, oppFinal, ms.id);
}

// =============================================
// ARROWMATCH — Total-Score Mode
// Enter all arrows → submit → wait for opponent result.
// Reacts to WS_OPP_SCORE_DONE from EventBus instead of polling directly
// from the WebSocket handler.
//
// Depends on: core/state.js, core/api.js, core/event-bus.js,
//             match/match-state.js, match/score-input.js, match/bot.js
// =============================================

let _pollInterval = null;
let _pollMatchId  = null; // locked at poll start, survives match switching

// When server pushes "opponent has submitted their score" → accelerate poll
EventBus.on(EVENT_TYPES.WS_OPP_SCORE_DONE, ({ matchId }) => {
  const ms = STATE.activeMatches[matchId];
  if (!ms) return;

  if (STATE.currentMatchId === matchId && ms._polling) {
    // Speed-poll: opponent is done, get the result now
    clearInterval(_pollInterval);
    _pollInterval = null;
    _pollForResult();
  } else if (STATE.currentMatchId !== matchId) {
    showToast(`${ms.oppName} submitted their score in another match!`, 'info');
  }
});

// ── Total-score logic ─────────────────────────────────────────────────────────

async function checkTotalComplete() {
  const ms = STATE.matchState;
  if (!arrowValues.every(v => v !== null)) return;

  const myScore = arrowValues.reduce((a, b) => a + b, 0);
  _setNumpadDisabled(true);

  await _submitScoreToServer(arrowValues);

  if (ms.isBot) {
    const botScore = _genBotTotal(myScore, ms.oppSkill || 'Skilled');
    if (myScore === botScore) _startTotalTiebreak(myScore);
    else                      completeMatch(myScore, botScore, ms.id);
    return;
  }

  _setStatus(`Score submitted (${myScore}). Waiting for ${ms.oppName}…`);
  ms._totalMyScore = myScore;
  ms._polling      = true;
  _pollForResult();
}

function _pollForResult() {
  if (_pollInterval) clearInterval(_pollInterval);
  _pollMatchId  = STATE.currentMatchId;
  _pollInterval = setInterval(async () => {
    const mid = _pollMatchId;
    const ms  = STATE.activeMatches[mid];
    if (!ms || ms.complete) { clearInterval(_pollInterval); _pollInterval = null; return; }

    try {
      const status = await api('GET', `/api/matches/${ms.id}/status`);
      if (!status) return;

      if (status.tiebreak_required) {
        clearInterval(_pollInterval); _pollInterval = null;
        if (STATE.currentMatchId === mid) _startTotalTiebreak(ms._totalMyScore);
        return;
      }

      if (status.status === 'complete' && status.result) {
        clearInterval(_pollInterval); _pollInterval = null;
        if (STATE.currentMatchId === mid) _setStatus('');
        completeMatch(ms._totalMyScore, status.opp_score ?? 0, mid);
      }
    } catch {}
  }, 2000);
}

function _startTotalTiebreak(myCurrentScore) {
  const ms = STATE.matchState;
  ms._tiebreakTotal = true;
  ms._tiebreakBase  = myCurrentScore;
  arrowValues       = [null];
  activeArrowIndex  = 0;

  // Repurpose the set-score UI for single tiebreak arrow
  document.getElementById('total-score-ui').classList.add('hidden');
  document.getElementById('set-score-ui').classList.remove('hidden');
  buildSetArrowRow(1);
  refreshSetArrowCells();
  _setNumpadDisabled(false);
  _setStatus('');
  document.getElementById('set-progress').textContent = 'Tiebreak — sudden death';
  showToast('Scores tied! One arrow decides.', 'info');
  saveMatchState();
}

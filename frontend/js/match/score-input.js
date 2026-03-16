// =============================================
// ARROWMATCH — Score Input UI
// Arrow cell rendering, numpad handlers, match scene layout.
// Handles all match-scene DOM — the only module that touches match overlay HTML.
//
// Subscribes to:
//   APP_MATCH_STARTED, APP_MATCH_SWITCHED, APP_MATCH_COMPLETE
//   APP_FORFEIT_REQUESTED (two-step confirm logic lives here)
//   APP_REMATCH_* events (overlay state management)
//   APP_SHOW_REMATCH_REQUEST, APP_OPP_NAME_UPDATE
//   WS_OPP_ARROW (live arrow indicator)
//
// Depends on: core/state.js, core/event-bus.js, core/utils.js,
//             match/match-state.js, match/total-mode.js, match/set-mode.js,
//             core/ws.js
// =============================================

// ── EventBus: match lifecycle ─────────────────────────────────────────────────

EventBus.on(EVENT_TYPES.APP_MATCH_STARTED, ({ matchState, restored, background }) => {
  if (background) return;
  renderMatchScene();  // renderMatchScene already restores arrowValues from matchState
  _resetRematchUI();
});

EventBus.on(EVENT_TYPES.APP_MATCH_SWITCHED, ({ matchState }) => {
  arrowValues = [...(matchState.arrowValues || [])];
  renderMatchScene();
});

EventBus.on(EVENT_TYPES.WS_OPP_ARROW, ({ matchId, arrow_index, value }) => {
  if (STATE.currentMatchId !== matchId) return;
  const ms = STATE.matchState;
  if (!ms) return;

  if (ms.scoring === 'total') {
    _showOpponentArrowIndicator(ms.oppName, arrow_index, value);
  } else if (ms.scoring === 'sets') {
    // arrow_index is the position within the current set (0, 1, 2)
    const setArrows = ms._oppSetArrows || [];
    setArrows[arrow_index] = value;
    ms._oppSetArrows = setArrows;
    _showOppSetLive(ms.oppName, setArrows);
  }
});

EventBus.on(EVENT_TYPES.APP_MATCH_COMPLETE, ({ wasDisplayed, myScore, oppScore, result, tiebreakArrows, matchState }) => {
  if (!wasDisplayed) return;

  let icon, title;
  if (result === 'win')       { icon = '🏆'; title = 'You Win!'; }
  else if (result === 'loss') { icon = '😤'; title = 'Better luck next time'; }
  else if (result === 'draw') { icon = '🤝'; title = "It's a Draw!"; }
  else {
    if (myScore > oppScore)      { icon = '🏆'; title = 'You Win!'; }
    else if (oppScore > myScore) { icon = '😤'; title = 'Better luck next time'; }
    else                         { icon = '🤝'; title = "It's a Draw!"; }
  }

  let resultLine;
  if (matchState.scoring === 'sets') {
    resultLine = `Set points: ${myScore}–${oppScore}`;
  } else if (tiebreakArrows) {
    resultLine = `Score: ${myScore} vs ${oppScore} · Tiebreak: ${tiebreakArrows.my} vs ${tiebreakArrows.opp}`;
  } else {
    resultLine = `Score: ${myScore} vs ${oppScore}`;
  }

  document.getElementById('complete-icon').textContent   = icon;
  document.getElementById('complete-title').textContent  = title;
  document.getElementById('complete-result').textContent = resultLine;
  document.getElementById('match-complete').classList.remove('hidden');
  _setNumpadDisabled(false);
  _setStatus('');
  document.getElementById('forfeit-btn')?.classList.add('hidden');
});

// ── EventBus: opponent name ───────────────────────────────────────────────────

EventBus.on(EVENT_TYPES.APP_OPP_NAME_UPDATE, ({ matchId, name }) => {
  if (STATE.currentMatchId !== matchId) return;
  const el = document.getElementById('ch-opp-name');
  if (el) el.textContent = name;
});

// ── EventBus: forfeit two-step confirm ────────────────────────────────────────

let _forfeitConfirming = false;
let _forfeitTimer      = null;

EventBus.on(EVENT_TYPES.APP_FORFEIT_REQUESTED, () => {
  const btn = document.getElementById('forfeit-btn');
  if (!btn) return;

  if (!_forfeitConfirming) {
    _forfeitConfirming      = true;
    btn.textContent         = 'Confirm forfeit?';
    btn.style.background    = 'rgba(242,96,96,0.25)';
    _forfeitTimer = setTimeout(() => {
      _forfeitConfirming   = false;
      btn.textContent      = '✕ Forfeit';
      btn.style.background = '';
    }, 4000);
  } else {
    clearTimeout(_forfeitTimer);
    _forfeitConfirming   = false;
    btn.textContent      = 'Forfeiting…';
    btn.disabled         = true;
    btn.style.background = '';
    EventBus.emit(EVENT_TYPES.APP_FORFEIT_CONFIRMED, {});
  }
});

EventBus.on(EVENT_TYPES.APP_FORFEIT_FAILED, () => {
  const btn = document.getElementById('forfeit-btn');
  if (btn) { btn.textContent = '✕ Forfeit'; btn.disabled = false; }
  _forfeitConfirming = false;
});

// ── EventBus: rematch overlay ─────────────────────────────────────────────────

EventBus.on(EVENT_TYPES.APP_REMATCH_PENDING, () => {
  document.getElementById('complete-actions')?.classList.add('hidden');
  document.getElementById('rematch-pending')?.classList.remove('hidden');
});

EventBus.on(EVENT_TYPES.APP_REMATCH_PENDING_CANCEL, () => {
  document.getElementById('complete-actions')?.classList.remove('hidden');
  document.getElementById('rematch-pending')?.classList.add('hidden');
});

EventBus.on(EVENT_TYPES.APP_REMATCH_ACCEPTED_LOCAL, () => {
  document.getElementById('rematch-request')?.classList.add('hidden');
});

EventBus.on(EVENT_TYPES.APP_REMATCH_ACCEPTED_FAIL, () => {
  document.getElementById('rematch-request')?.classList.remove('hidden');
});

EventBus.on(EVENT_TYPES.APP_REMATCH_DECLINED_LOCAL, () => {
  document.getElementById('rematch-request')?.classList.add('hidden');
  document.getElementById('complete-actions')?.classList.remove('hidden');
});

EventBus.on(EVENT_TYPES.APP_REMATCH_OVERLAY_HIDE, () => {
  document.getElementById('match-complete')?.classList.add('hidden');
});

EventBus.on(EVENT_TYPES.APP_REMATCH_ACTIONS_SHOW, () => {
  document.getElementById('complete-actions')?.classList.remove('hidden');
});

EventBus.on(EVENT_TYPES.APP_SHOW_REMATCH_REQUEST, ({ matchId, proposerName }) => {
  const requestEl = document.getElementById('rematch-request');
  const textEl    = document.getElementById('rematch-request-text');
  const actionsEl = document.getElementById('complete-actions');
  if (!requestEl) return;
  if (textEl) textEl.textContent = `${proposerName} wants a rematch!`;
  actionsEl?.classList.add('hidden');
  requestEl.classList.remove('hidden');
  // Store match id for accept/decline
  requestEl.dataset.matchId = matchId;
  const prev = STATE.lastCompletedMatch;
  if (prev) prev._rematchMatchId = matchId;
});

// ── Scene render ──────────────────────────────────────────────────────────────

function renderMatchScene() {
  const ms = STATE.matchState;
  if (!ms) return;

  _setNumpadDisabled(false);

  document.getElementById('ch-my-name').textContent  = ms.myName;
  document.getElementById('ch-opp-name').textContent = ms.oppName;
  document.getElementById('ch-dist').textContent     = ms.dist;

  const isTiebreak = ms._tiebreakRequired === true;
  const isTotal    = ms.scoring === 'total' || isTiebreak;
  const arrowCount = isTiebreak ? 1 : ms.arrowCount;

  document.getElementById('total-score-ui').classList.toggle('hidden', !isTotal);
  document.getElementById('set-score-ui').classList.toggle('hidden', isTotal);

  if (isTotal) {
    buildArrowRows(arrowCount);
    const savedValues = isTiebreak ? [] : ms.arrowValues;
    arrowValues      = savedValues.length ? [...savedValues] : new Array(arrowCount).fill(null);
    activeArrowIndex = arrowValues.findIndex(v => v === null);
    if (activeArrowIndex === -1) activeArrowIndex = arrowCount - 1;
    refreshArrowCells();
    updateTotalSum();
    if (isTiebreak) _setStatus('Sudden death — shoot one arrow! Highest wins.');
  } else {
    buildSetArrowRow();
    arrowValues = ms.setArrowValues.length ? [...ms.setArrowValues] : new Array(3).fill(null);
    activeArrowIndex = arrowValues.findIndex(v => v === null);
    if (activeArrowIndex === -1) activeArrowIndex = 2;
    refreshSetArrowCells();
    document.getElementById('set-my-name').textContent  = ms.myName;
    document.getElementById('set-opp-name').textContent = ms.oppName;
    refreshSetScore();
    // Restore set progress label from state (currentSet is synced from server on page load)
    const progressEl = document.getElementById('set-progress');
    if (progressEl) progressEl.textContent = `Set ${ms.currentSet ?? 1}`;
  }

  document.getElementById('match-complete').classList.add('hidden');

  const forfeitBtn = document.getElementById('forfeit-btn');
  if (forfeitBtn) {
    forfeitBtn.classList.toggle('hidden', ms.complete || false);
    forfeitBtn.textContent = '✕ Forfeit';
    forfeitBtn.disabled    = false;
    forfeitBtn.style.background = '';
    _forfeitConfirming = false;
    if (_forfeitTimer) { clearTimeout(_forfeitTimer); _forfeitTimer = null; }
  }
}

function _resetRematchUI() {
  document.getElementById('complete-actions')?.classList.remove('hidden');
  document.getElementById('rematch-pending')?.classList.add('hidden');
  document.getElementById('rematch-request')?.classList.add('hidden');
}

// ── Arrow cell builders ───────────────────────────────────────────────────────

function buildArrowRows(count) {
  const container = document.getElementById('arrow-rows');
  const rowCount  = Math.ceil(count / 3);
  let html = '';
  for (let r = 0; r < rowCount; r++) {
    const start = r * 3;
    html += `<div class="arrow-row">
      <span class="arrow-row-num">${r + 1}</span>
      <div class="arrow-inputs">`;
    for (let i = 0; i < 3; i++) {
      const idx = start + i;
      html += idx < count
        ? `<div class="arrow-cell" id="ac-${idx}" onclick="activateCell(${idx})"></div>`
        : `<div class="arrow-cell" style="visibility:hidden"></div>`;
    }
    html += `</div><span class="row-sum" id="rs-${r}"></span></div>`;
  }
  container.innerHTML = html;
}

function buildSetArrowRow(count = 3) {
  const container = document.getElementById('set-arrow-row');
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const cell     = document.createElement('div');
    cell.className = 'arrow-cell';
    cell.id        = `sac-${i}`;
    cell.onclick   = () => activateSetCell(i);
    container.appendChild(cell);
  }
  // NOTE: callers are responsible for setting arrowValues before calling refreshSetArrowCells()
}

function activateCell(idx) {
  const nextEmpty = arrowValues.findIndex(v => v === null);
  if (nextEmpty !== -1 && idx > nextEmpty) return;
  activeArrowIndex = idx;
  refreshArrowCells();
}

function activateSetCell(idx) {
  const nextEmpty = arrowValues.findIndex(v => v === null);
  if (nextEmpty !== -1 && idx > nextEmpty) return;
  activeArrowIndex = idx;
  refreshSetArrowCells();
}

// ── Cell refresh ──────────────────────────────────────────────────────────────

function refreshArrowCells() {
  const ms    = STATE.matchState;
  if (!ms) return;
  const count = ms._tiebreakRequired ? 1 : ms.arrowCount;
  for (let i = 0; i < count; i++) {
    const cell = document.getElementById(`ac-${i}`);
    if (!cell) continue;
    const v = arrowValues[i];
    cell.className = 'arrow-cell';
    if (i === activeArrowIndex) cell.classList.add('active');
    if (v !== null) {
      cell.textContent = v;
      if      (v === 10) cell.classList.add('filled-10');
      else if (v === 9)  cell.classList.add('filled-9');
      else if (v === 8)  cell.classList.add('filled-8');
      else               cell.classList.add('filled');
    } else { cell.textContent = ''; }
  }
  const rowCount = Math.ceil(count / 3);
  for (let r = 0; r < rowCount; r++) {
    const start  = r * 3;
    const end    = Math.min(start + 3, count);
    const filled = arrowValues.slice(start, end).filter(v => v !== null);
    const rsEl   = document.getElementById(`rs-${r}`);
    if (rsEl) rsEl.textContent = filled.length === (end - start)
      ? filled.reduce((a, b) => a + b, 0) : '';
  }
}

function refreshSetArrowCells() {
  for (let i = 0; i < 3; i++) {
    const cell = document.getElementById(`sac-${i}`);
    if (!cell) continue;
    const v = arrowValues[i];
    cell.className = 'arrow-cell';
    if (i === activeArrowIndex) cell.classList.add('active');
    if (v !== null) {
      cell.textContent = v;
      if      (v === 10) cell.classList.add('filled-10');
      else if (v === 9)  cell.classList.add('filled-9');
      else if (v === 8)  cell.classList.add('filled-8');
      else               cell.classList.add('filled');
    } else { cell.textContent = ''; }
  }
}

function updateTotalSum() {
  const sum = arrowValues.filter(v => v !== null).reduce((a, b) => a + b, 0);
  document.getElementById('total-sum').textContent = sum;
}

function refreshSetScore() {
  const ms = STATE.matchState;
  if (!ms) return;
  document.getElementById('set-my-score') .textContent = ms.setMyScore  ?? 0;
  document.getElementById('set-opp-score').textContent = ms.setOppScore ?? 0;
}

// ── Numpad handlers ───────────────────────────────────────────────────────────

function numInput(val) {
  if (STATE.matchState?.scoring === 'sets') numInputSet(val);
  else                                      numInputTotal(val);
  saveMatchState();
}

function numInputTotal(val) {
  const ms    = STATE.matchState;
  const count = ms._tiebreakRequired ? 1 : ms.arrowCount;
  if (activeArrowIndex >= count) return;
  const prevIdx = activeArrowIndex;
  arrowValues[activeArrowIndex] = val;
  if (!ms._tiebreakRequired) ms.arrowValues = [...arrowValues];
  const next = arrowValues.findIndex(v => v === null);
  activeArrowIndex = next === -1 ? count - 1 : next;
  refreshArrowCells();
  updateTotalSum();
  sendMatchMessage({ type: 'arrow', arrow_index: prevIdx, value: val });
  checkTotalComplete();
}

function numInputSet(val) {
  const ms     = STATE.matchState;
  const maxIdx = arrowValues.length - 1;
  if (activeArrowIndex > maxIdx) return;
  const prevIdx = activeArrowIndex;
  arrowValues[activeArrowIndex] = val;
  ms.setArrowValues = [...arrowValues];
  const next = arrowValues.findIndex((v, i) => i > activeArrowIndex && v === null);
  activeArrowIndex = next === -1 ? maxIdx : next;
  refreshSetArrowCells();
  // Stream arrow to opponent (arrow_index is set-relative: 0, 1, 2)
  sendMatchMessage({ type: 'arrow', arrow_index: prevIdx, value: val });
  if (arrowValues.length > 0 && arrowValues.every(v => v !== null)) {
    setTimeout(() => {
      if (ms._tiebreak) resolveTiebreak();
      else              resolveSet();
    }, 400);
  }
}

function numDel() {
  if (STATE.matchState?.scoring === 'sets') numDelSet();
  else                                      numDelTotal();
  saveMatchState();
}

function numDelTotal() {
  const ms    = STATE.matchState;
  const count = ms._tiebreakRequired ? 1 : ms.arrowCount;
  let target  = activeArrowIndex;
  if (arrowValues[target] === null) {
    for (let i = target - 1; i >= 0; i--) {
      if (arrowValues[i] !== null) { target = i; break; }
    }
  }
  arrowValues[target] = null;
  if (!ms._tiebreakRequired) ms.arrowValues = [...arrowValues];
  activeArrowIndex = target;
  refreshArrowCells();
  updateTotalSum();
}

function numDelSet() {
  let target = activeArrowIndex;
  if (arrowValues[target] === null) {
    for (let i = target - 1; i >= 0; i--) {
      if (arrowValues[i] !== null) { target = i; break; }
    }
  }
  arrowValues[target]             = null;
  STATE.matchState.setArrowValues = [...arrowValues];
  activeArrowIndex                = target;
  refreshSetArrowCells();
}

// ── Score submission ──────────────────────────────────────────────────────────

async function _submitScoreToServer(arrows) {
  const ms = STATE.matchState;
  if (!ms?.id || ms.isBot) return true;
  if (ms.id === ms.challengeId) {
    _setStatus('Waiting for opponent to join…');
    _setNumpadDisabled(false);
    return null;
  }
  const clean = arrows
    .map((v, i) => ({ arrow_index: i, value: v }))
    .filter(a => a.value !== null && a.value !== undefined);
  if (clean.length === 0) { _setNumpadDisabled(false); return null; }

  try {
    return await api('POST', `/api/matches/${ms.id}/score`, { arrows: clean });
  } catch (e) {
    if (e?.status === 404) {
      _setNumpadDisabled(true);
      _setStatus('This match is no longer available.');
      return null;
    }
    showToast(e.message || 'Could not submit score — try again', 'error');
    _setNumpadDisabled(false);
    _setStatus('');
    return null;
  }
}

// ── Status / numpad helpers ───────────────────────────────────────────────────

function _setStatus(msg) {
  const el = document.getElementById('match-status');
  if (el) { el.textContent = msg; el.classList.toggle('hidden', !msg); }
}

function _setNumpadDisabled(disabled) {
  document.querySelectorAll('.num-btn').forEach(b => { b.disabled = disabled; });
}

// ── Opponent live indicator ───────────────────────────────────────────────────

function _oppIndicatorShow(text) {
  const el = document.getElementById('opponent-results');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('has-data');
  el.textContent = text;
}

function _oppIndicatorHide() {
  const el = document.getElementById('opponent-results');
  if (!el) return;
  el.classList.add('hidden');
  el.classList.remove('has-data');
  el.textContent = '';
}

// Total mode: "Brave: arrow 2 → 9" — static, stays until next arrow or scene change
function _showOpponentArrowIndicator(oppName, arrowIndex, value) {
  _oppIndicatorShow(`${oppName}: arrow ${arrowIndex + 1} → ${value}`);
}

// Sets mode post-resolve summary: "Brave: 10 9 10 = 29 pts"
function _showOppSetArrows(oppTotal, arrows) {
  const ms = STATE.matchState;
  const arrowStr = arrows.length ? arrows.join(' ') + ' = ' : '';
  _oppIndicatorShow(`${ms?.oppName || 'Opp'}: ${arrowStr}${oppTotal} pts`);
}

/**
 * Sets mode live progress: "Brave: [10, 9, –]: 19"
 * setArrows: sparse array indexed 0-2, missing values shown as –
 * Static — stays until _nextSet() clears it.
 */
function _showOppSetLive(oppName, setArrows) {
  const slots  = [0, 1, 2].map(i => setArrows[i] != null ? setArrows[i] : '–');
  const filled = setArrows.filter(v => v != null);
  const total  = filled.reduce((a, b) => a + b, 0);
  const totalStr = filled.length > 0 ? `: ${total}` : '';
  _oppIndicatorShow(`${oppName}: [${slots.join(', ')}]${totalStr}`);
}

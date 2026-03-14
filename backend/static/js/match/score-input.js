// =============================================
// ARROWMATCH — Score Input UI
// Arrow cell rendering, numpad handlers, match scene layout.
// Depends on: core/state.js, core/utils.js,
//             match/match-state.js, match/total-mode.js, match/set-mode.js
// =============================================

// ── Scene render ──────────────────────────────────────────────────────────────

function renderMatchScene() {
  const ms = STATE.matchState;
  document.getElementById('ch-my-name').textContent  = ms.myName;
  document.getElementById('ch-opp-name').textContent = ms.oppName;
  document.getElementById('ch-dist').textContent     = ms.dist;

  // Ensure status bar element exists
  if (!document.getElementById('match-status')) {
    const el = document.createElement('div');
    el.id        = 'match-status';
    el.className = 'match-status-bar hidden';
    document.getElementById('score-board')?.prepend(el);
  }

  const isTotal = ms.scoring === 'total';
  document.getElementById('total-score-ui').classList.toggle('hidden', !isTotal);
  document.getElementById('set-score-ui').classList.toggle('hidden', isTotal);

  if (isTotal) {
    buildArrowRows(ms.arrowCount);
    arrowValues      = ms.arrowValues.length ? [...ms.arrowValues] : new Array(ms.arrowCount).fill(null);
    activeArrowIndex = arrowValues.findIndex(v => v === null);
    if (activeArrowIndex === -1) activeArrowIndex = ms.arrowCount - 1;
    refreshArrowCells();
  } else {
    arrowValues = ms.setArrowValues.length ? [...ms.setArrowValues] : new Array(3).fill(null);
    buildSetArrowRow();
    activeArrowIndex = arrowValues.findIndex(v => v === null);
    if (activeArrowIndex === -1) activeArrowIndex = 2;
    refreshSetArrowCells();
    document.getElementById('set-my-name').textContent  = ms.myName;
    document.getElementById('set-opp-name').textContent = ms.oppName;
    refreshSetScore();
  }

  document.getElementById('match-complete').classList.add('hidden');

  const forfeitBtn = document.getElementById('forfeit-btn');
  if (forfeitBtn) {
    forfeitBtn.classList.toggle('hidden', ms.complete || false);
    forfeitBtn.textContent        = '✕ Forfeit';
    forfeitBtn.disabled           = false;
    forfeitBtn.dataset.confirming = 'false';
    forfeitBtn.style.background   = '';
  }
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
  arrowValues = new Array(count).fill(null);
}

function activateCell(idx)    { activeArrowIndex = idx; refreshArrowCells(); }
function activateSetCell(idx) { activeArrowIndex = idx; refreshSetArrowCells(); }

// ── Cell refresh ──────────────────────────────────────────────────────────────

function refreshArrowCells() {
  const ms = STATE.matchState;
  for (let i = 0; i < ms.arrowCount; i++) {
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
    } else {
      cell.textContent = '';
    }
  }
  const rowCount = Math.ceil(ms.arrowCount / 3);
  for (let r = 0; r < rowCount; r++) {
    const start  = r * 3;
    const end    = Math.min(start + 3, ms.arrowCount);
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
    } else {
      cell.textContent = '';
    }
  }
}

function updateTotalSum() {
  const sum = arrowValues.filter(v => v !== null).reduce((a, b) => a + b, 0);
  document.getElementById('total-sum').textContent = sum;
}

/** Update the set-system scoreboard (e.g. "2:0"). */
function refreshSetScore() {
  const ms = STATE.matchState;
  if (!ms) return;
  const myEl  = document.getElementById('set-my-score');
  const oppEl = document.getElementById('set-opp-score');
  if (myEl)  myEl.textContent  = ms.setMyScore  ?? 0;
  if (oppEl) oppEl.textContent = ms.setOppScore ?? 0;
}

// ── Numpad handlers ───────────────────────────────────────────────────────────

function numInput(val) {
  if (STATE.matchState?.scoring === 'sets') {
    numInputSet(val);
  } else {
    numInputTotal(val);
  }
  saveMatchState();
  if (matchSocket?.readyState === WebSocket.OPEN) {
    matchSocket.send(JSON.stringify({ type: 'score_update', arrow_index: activeArrowIndex, value: val }));
  }
}

function numInputTotal(val) {
  const ms = STATE.matchState;
  if (activeArrowIndex >= ms.arrowCount) return;
  const prevIdx = activeArrowIndex;
  arrowValues[activeArrowIndex] = val;
  ms.arrowValues = [...arrowValues];
  const next = arrowValues.findIndex((v, i) => i > activeArrowIndex && v === null);
  activeArrowIndex = next === -1 ? ms.arrowCount - 1 : next;
  refreshArrowCells();
  updateTotalSum();

  if (matchSocket?.readyState === WebSocket.OPEN) {
    matchSocket.send(JSON.stringify({ type: 'arrow', arrow_index: prevIdx, value: val }));
  }

  checkTotalComplete();
}

function numInputSet(val) {
  const ms     = STATE.matchState;
  const maxIdx = arrowValues.length - 1;
  if (activeArrowIndex > maxIdx) return;
  arrowValues[activeArrowIndex] = val;
  ms.setArrowValues = [...arrowValues];
  const next = arrowValues.findIndex((v, i) => i > activeArrowIndex && v === null);
  activeArrowIndex = next === -1 ? maxIdx : next;
  refreshSetArrowCells();
  if (arrowValues.every(v => v !== null)) {
    setTimeout(() => {
      if (ms._tiebreak || ms._tiebreakTotal) resolveTiebreak();
      else                                   resolveSet();
    }, 400);
  }
}

function numDel() {
  if (STATE.matchState?.scoring === 'sets') numDelSet();
  else                                      numDelTotal();
  saveMatchState();
}

function numDelTotal() {
  const ms = STATE.matchState;
  let target = activeArrowIndex;
  if (arrowValues[target] === null) {
    for (let i = target - 1; i >= 0; i--) {
      if (arrowValues[i] !== null) { target = i; break; }
    }
  }
  arrowValues[target] = null;
  ms.arrowValues      = [...arrowValues];
  activeArrowIndex    = target;
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
  arrowValues[target]           = null;
  STATE.matchState.setArrowValues = [...arrowValues];
  activeArrowIndex              = target;
  refreshSetArrowCells();
}

// ── Score submission ──────────────────────────────────────────────────────────

async function _submitScoreToServer(arrows) {
  const ms = STATE.matchState;
  if (!ms?.id || ms.isBot) return;
  const payload = { arrows: arrows.map((value, arrow_index) => ({ arrow_index, value })) };
  try {
    await api('POST', `/api/matches/${ms.id}/score`, payload);
  } catch (e) {
    console.warn('Score submit failed:', e.message);
  }
  if (matchSocket?.readyState === WebSocket.OPEN) {
    matchSocket.send(JSON.stringify({ type: 'score_submitted' }));
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

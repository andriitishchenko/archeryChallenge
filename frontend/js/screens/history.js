// =============================================
// ARROWMATCH — History Screen
// Stats, achievements, match history list.
// Depends on: core/state.js, core/api.js, core/utils.js
// =============================================

async function saveToHistory(ms) {
  const entry = {
    id:       `h-${Date.now()}`,
    oppName:  ms.oppName,
    dist:     ms.dist,
    scoring:  ms.scoring,
    myScore:  ms.myFinalScore  || 0,
    oppScore: ms.oppFinalScore || 0,
    result:   (ms.myFinalScore || 0) > (ms.oppFinalScore || 0) ? 'win'
            : (ms.myFinalScore || 0) < (ms.oppFinalScore || 0) ? 'loss' : 'draw',
    date:     new Date().toISOString(),
  };
  STATE.history.unshift(entry);
  if (STATE.history.length > 100) STATE.history.pop();
  localStorage.setItem('arrowmatch_history', JSON.stringify(STATE.history));
}

async function refreshHistory() {
  let serverAchievements = null;
  try {
    const [histData, achData] = await Promise.all([
      api('GET', '/api/history?limit=30'),
      api('GET', '/api/achievements'),
    ]);
    if (histData) {
      STATE.history = histData.map(h => ({
        id:       h.match_id,
        oppName:  h.opponent_name,
        dist:     h.distance,
        scoring:  h.scoring,
        myScore:  h.my_score || 0,
        oppScore: h.opponent_score || 0,
        result:   h.result,
        date:     h.date,
      }));
      localStorage.setItem('arrowmatch_history', JSON.stringify(STATE.history));
    }
    if (achData) serverAchievements = achData;
  } catch {}

  renderStats();
  renderAchievements(serverAchievements);
  renderHistoryList();
}

function renderStats() {
  const last10   = STATE.history.slice(0, 10);
  const wins     = last10.filter(h => h.result === 'win').length;
  const avgScore = last10.length
    ? Math.round(last10.reduce((a, h) => a + h.myScore, 0) / last10.length) : 0;
  const globalRank = Math.max(1, 1000 - wins * 50);
  document.getElementById('stat-avg').textContent  = avgScore || '—';
  document.getElementById('stat-wins').textContent = wins;
  document.getElementById('stat-rank').textContent = `#${globalRank}`;
}

function renderAchievements(serverBadges = null) {
  let badges;
  if (serverBadges && Array.isArray(serverBadges)) {
    badges = serverBadges.map(b => ({ icon: b.icon, label: b.label, earned: b.earned }));
  } else {
    const total = STATE.history.length;
    let streak  = 0;
    for (const h of STATE.history) { if (h.result === 'win') streak++; else break; }
    badges = [
      { icon: '🔥', label: '5 Win Streak',  earned: streak >= 5   },
      { icon: '⚡', label: '10 Win Streak', earned: streak >= 10  },
      { icon: '👑', label: '25 Win Streak', earned: streak >= 25  },
      { icon: '🎯', label: '10 Matches',    earned: total  >= 10  },
      { icon: '🏹', label: '50 Matches',    earned: total  >= 50  },
      { icon: '🌟', label: '100 Matches',   earned: total  >= 100 },
    ];
  }
  document.getElementById('achievements-grid').innerHTML = badges.map(b => `
    <div class="achievement-badge ${b.earned ? 'earned' : ''}">
      <span class="badge-icon">${b.icon}</span>
      <span class="badge-label">${b.label}</span>
    </div>`).join('');
}

function renderHistoryList() {
  const container = document.getElementById('history-list');
  if (STATE.history.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">◷</div><p class="empty-text">No matches played yet</p></div>`;
    return;
  }
  const icons = { win: '✓', loss: '✗', draw: '=' };
  container.innerHTML = STATE.history.slice(0, 30).map(h => `
    <div class="history-item">
      <div class="hi-result ${h.result}">${icons[h.result]}</div>
      <div class="hi-info">
        <div class="hi-opp">${escHtml(h.oppName)}</div>
        <div class="hi-meta">${h.dist} · ${h.scoring === 'sets' ? 'Sets' : 'Total'} · ${formatDate(new Date(h.date))}</div>
      </div>
      <div class="hi-score ${h.result}">${h.myScore}</div>
    </div>`).join('');
}

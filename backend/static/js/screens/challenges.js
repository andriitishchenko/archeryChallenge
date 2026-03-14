// =============================================
// ARROWMATCH — Challenges Screen
// List, new, my challenges, filters, invite links.
// Depends on: core/state.js, core/api.js, core/utils.js,
//             match/match-state.js, match/bot.js
// =============================================

// ── Challenge List ────────────────────────────────────────────────────────────

async function refreshChallengeList() {
  const container = document.getElementById('challenge-list');
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const f = STATE.filters;
    const params = new URLSearchParams();
    f.skill.forEach(v  => params.append('skill', v));
    f.gender.forEach(v => params.append('gender', v));
    f.bow.forEach(v    => params.append('bow', v));
    f.dist.forEach(v   => params.append('dist', v));
    if (f.country) params.set('country', f.country);

    const data = await api('GET', `/api/challenges?${params}`);
    if (data) { STATE.challenges = data; renderChallengeList(); return; }
  } catch (e) {
    console.warn('Could not load challenges:', e.message);
  }

  if (STATE.challenges.length === 0) STATE.challenges = generateMockChallenges();
  renderChallengeList();
}

function renderChallengeList() {
  const container = document.getElementById('challenge-list');
  const list = STATE.challenges;

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎯</div><p class="empty-text">No open challenges match your filters</p></div>`;
    return;
  }

  container.innerHTML = list.map(c => {
    const name  = c.creator_name || c.name || 'Archer';
    const gender = c.creator_gender || c.gender || '—';
    const age   = c.creator_age || c.age || '—';
    const bow   = c.creator_bow_type || c.bowType || '—';
    const skill = c.creator_skill_level || c.skillLevel || '—';
    const dist  = c.distance || '—';
    const msg   = c.invite_message || c.msg || '';
    const date  = new Date(c.created_at || c.createdAt);
    return `
    <div class="challenge-card" onclick="joinChallenge('${c.id}')">
      <div class="ch-card-top">
        <span class="ch-card-name">${escHtml(name)}</span>
        <span class="ch-card-date">${getTimeAgo(date)}</span>
      </div>
      <div class="ch-card-tags">
        <span class="ch-tag dist">${dist}</span>
        <span class="ch-tag">${bow}</span>
        <span class="ch-tag">${skill}</span>
        <span class="ch-tag">${gender}</span>
        <span class="ch-tag">${age}</span>
      </div>
      ${msg ? `<div class="ch-card-msg">"${escHtml(msg)}"</div>` : ''}
      <div class="ch-card-action">
        <button class="btn-join" onclick="event.stopPropagation(); joinChallenge('${c.id}')">Join</button>
      </div>
    </div>`;
  }).join('');
}

async function joinChallenge(id) {
  if (!STATE.profile) { showToast('Complete your profile first', 'error'); showScene('settings'); return; }

  try {
    const data = await api('POST', `/api/challenges/${id}/join`);
    if (data?.match_id) {
      const ch = STATE.challenges.find(c => c.id === id) || {};
      startMatch({ ...ch, matchId: data.match_id, name: ch.creator_name || ch.name || 'Opponent' });
      return;
    }
  } catch (e) {
    if (e.status !== 404) { showToast(e.message || 'Could not join', 'error'); return; }
  }

  const ch = STATE.challenges.find(c => c.id === id) || generateMockOpponent(id);
  startMatch(ch);
}

// ── New Challenge ─────────────────────────────────────────────────────────────

function selectMatchType(btn) {
  document.querySelectorAll('.match-type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  STATE.currentMatchType = btn.dataset.type;
  updateDeadlineVisibility();
}

function selectScoring(btn) {
  document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  STATE.currentScoring = btn.dataset.scoring;
  document.getElementById('scoring-total-opts').classList.toggle('hidden', STATE.currentScoring !== 'total');
  document.getElementById('scoring-sets-opts').classList.toggle('hidden',  STATE.currentScoring !== 'sets');
}

function changeArrows(delta) {
  STATE.arrowCount = Math.max(3, Math.min(36, STATE.arrowCount + delta));
  document.getElementById('arrows-count').textContent = STATE.arrowCount;
}

function updateDeadlineVisibility() {
  const show = ['async', 'scheduled'].includes(STATE.currentMatchType);
  document.getElementById('deadline-card').classList.toggle('hidden', !show);
}

function setupInviteMessageCounter() {
  const ta = document.getElementById('invite-msg');
  if (!ta) return;
  ta.addEventListener('input', () => {
    document.getElementById('msg-chars').textContent = ta.value.length;
  });
}

async function createChallenge() {
  if (!STATE.profile) { showToast('Complete your profile first', 'error'); showScene('settings'); return; }

  const distChip = document.querySelector('#dist-chips .chip.active');
  if (!distChip) { showToast('Select a distance', 'error'); return; }

  const type    = STATE.currentMatchType;
  const scoring = STATE.currentScoring;
  const msg     = document.getElementById('invite-msg').value.trim();
  let deadline  = null;

  if (['async', 'scheduled'].includes(type)) {
    const raw = document.getElementById('challenge-deadline').value;
    if (!raw) { showToast('Set a deadline', 'error'); return; }
    deadline = new Date(raw).toISOString();
  } else if (type === 'private') {
    const raw = document.getElementById('challenge-deadline').value;
    if (raw) deadline = new Date(raw).toISOString();
  }

  const payload = {
    match_type:     type,
    scoring,
    distance:       distChip.textContent.trim(),
    arrow_count:    STATE.arrowCount,
    invite_message: msg || null,
    deadline,
  };

  let challengeId;
  try {
    const data = await api('POST', '/api/challenges', payload);
    challengeId = data.id;
    STATE.myChallenges.unshift(data);
  } catch {
    challengeId = `local-${Date.now()}`;
    const localCh = { id: challengeId, ...payload, isPrivate: type === 'private', created_at: new Date().toISOString() };
    STATE.myChallenges.unshift(localCh);
    showToast('Created locally (offline)', 'info');
  }

  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));

  if (type === 'private') {
    copyToClipboard(buildChallengeLink(challengeId));
    showToast('Private link copied to clipboard!', 'success');
    showScene('my-challenges');
  } else if (type === 'live') {
    startMatch({
      id: challengeId, name: 'Waiting for opponent…',
      distance: distChip.textContent.trim(), scoring, arrowCount: STATE.arrowCount,
    }, true);
  } else {
    showScene('my-challenges');
    showToast('Challenge created!', 'success');
  }
}

function buildChallengeLink(id) {
  return `${location.origin}${location.pathname}?c=${id}`;
}

// ── My Challenges ─────────────────────────────────────────────────────────────

async function refreshMyChallenges() {
  const container = document.getElementById('my-challenges-list');

  try {
    const data = await api('GET', '/api/challenges/mine');
    if (data) {
      STATE.myChallenges = data;
      localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(data));
    }
  } catch {}

  if (STATE.myChallenges.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">◈</div><p class="empty-text">No challenges yet. Create one!</p></div>`;
    return;
  }

  container.innerHTML = STATE.myChallenges.map(ch => {
    const type    = ch.match_type || ch.type || '—';
    const scoring = ch.scoring || 'total';
    const dist    = ch.distance || '—';
    const arrows  = ch.arrow_count || ch.arrowCount;
    const isPriv  = ch.is_private === true || ch.isPrivate === true || ch.match_type === 'private';

    const activeMs = Object.values(STATE.activeMatches).find(
      ms => !ms.complete && (ms.challengeId === ch.id || ms.id === ch.id)
    );

    const activeRow = activeMs ? `
      <div class="active-match-row" onclick="switchToMatch('${activeMs.id}')">
        <span class="active-match-label">Live vs ${escHtml(activeMs.oppName)}</span>
        <button class="active-match-resume" onclick="switchToMatch('${activeMs.id}');event.stopPropagation()">Resume →</button>
      </div>` : '';

    return `
    <div class="my-ch-card${activeMs ? ' has-active-match' : ''}">
      <div class="my-ch-header">
        <span class="my-ch-title">${dist} · ${scoring === 'sets' ? 'Set System' : (arrows + ' arrows')}</span>
        <span class="my-ch-type">${type}</span>
      </div>
      ${activeRow}
      <div class="ch-card-tags" style="margin-bottom:12px">
        <span class="ch-tag">${ch.creator_bow_type || STATE.profile?.bowType || '—'}</span>
        <span class="ch-tag">${ch.creator_skill_level || STATE.profile?.skillLevel || '—'}</span>
      </div>
      <div class="my-ch-actions">
        ${isPriv ? `<button class="btn-sm btn-copy" onclick="copyPrivateLink('${ch.id}')">Copy Link</button>` : ''}
        <button class="btn-sm btn-danger" onclick="deleteChallenge('${ch.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function deleteChallenge(id) {
  STATE.myChallenges = STATE.myChallenges.filter(c => c.id !== id);
  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));
  refreshMyChallenges();

  try {
    await api('DELETE', `/api/challenges/${id}`);
    showToast('Challenge deleted', 'info');
  } catch (e) {
    showToast(e.message || 'Delete failed on server', 'error');
  }
}

function copyPrivateLink(id) {
  copyToClipboard(buildChallengeLink(id));
  showToast('Link copied!', 'success');
}

// ── Challenge invite link (URL param ?c=...) ──────────────────────────────────

async function handleChallengeLink(code) {
  showToast('Opening challenge…', 'info');
  showUI();
  try {
    const ch = await api('GET', `/api/challenges/${code}`);
    if (ch) {
      if (ch.is_active !== false) {
        try {
          const joined = await api('POST', `/api/challenges/${ch.id}/join`);
          if (joined?.match_id) {
            startMatch({ ...ch, matchId: joined.match_id, name: ch.creator_name || 'Challenger',
              scoring: ch.scoring, arrowCount: ch.arrow_count || 18 });
            return;
          }
        } catch {}
      }
      startMatch({ id: ch.id, name: ch.creator_name || 'Challenger',
        distance: ch.distance || '30m', scoring: ch.scoring || 'total',
        arrowCount: ch.arrow_count || 18, match_type: ch.match_type });
    } else {
      startMatch({ id: code, name: 'Challenger', distance: '30m', scoring: 'total', arrowCount: 18 });
    }
  } catch {
    startMatch({ id: code, name: 'Challenger', distance: '30m', scoring: 'total', arrowCount: 18 });
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

function toggleFilter(btn) {
  const filter = btn.dataset.filter;
  const val    = btn.dataset.val;
  btn.classList.toggle('active');
  const key = { skill: 'skill', gender: 'gender', bow: 'bow', dist: 'dist' }[filter];
  if (!key) return;
  if (btn.classList.contains('active')) {
    if (!STATE.filters[key].includes(val)) STATE.filters[key].push(val);
  } else {
    STATE.filters[key] = STATE.filters[key].filter(v => v !== val);
  }
  updateFilterBadge();
}

function updateFilterBadge() {
  const allSelected =
    STATE.filters.skill.length  === 3 &&
    STATE.filters.gender.length === 2 &&
    STATE.filters.bow.length    === 3 &&
    STATE.filters.dist.length   === 6 &&
    !STATE.filters.country;
  document.getElementById('filter-badge').textContent = allSelected ? 'All' : 'Active';
}

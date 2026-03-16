// =============================================
// ARROWMATCH — Challenges Screen
// List, new, my challenges, filters, invite links, matchmaking.
// Subscribes to EventBus for real-time challenge feed + matchmaking.
//
// Depends on: core/state.js, core/api.js, core/utils.js, core/event-bus.js,
//             match/match-state.js, match/bot.js
// =============================================

// ── Challenge feed ────────────────────────────────────────────────────────────

EventBus.on(EVENT_TYPES.WS_NEW_CHALLENGE, ({ challenge }) => {
  if (challenge.creator_id === STATE.userId) return;
  if (!_challengePassesFilters(challenge)) return;
  STATE.challenges.unshift(challenge);
  if (STATE.currentScene === 'list-challenge') renderChallengeList();
});

EventBus.on(EVENT_TYPES.WS_CHALLENGE_REMOVED, ({ challenge_id }) => {
  const idx = STATE.challenges.findIndex(c => c.id === challenge_id);
  if (idx !== -1) {
    STATE.challenges.splice(idx, 1);
    if (STATE.currentScene === 'list-challenge') renderChallengeList();
  }
});

// Refresh my-challenges when a scene change brings us there
EventBus.on(EVENT_TYPES.APP_SCENE_CHANGE, ({ scene }) => {
  if (scene === 'my-challenges') refreshMyChallenges();
  if (scene === 'list-challenge') refreshChallengeList();
});

// ── Matchmaking ───────────────────────────────────────────────────────────────

EventBus.on(EVENT_TYPES.WS_MM_STATUS, ({ message }) => {
  const statusEl = document.getElementById('find-status');
  if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> ${escHtml(message)}`;
});

EventBus.on(EVENT_TYPES.WS_MM_MATCHED, ({ match_id, opponent }) => {
  const statusEl = document.getElementById('find-status');
  const btn      = document.querySelector('.find-btn');
  if (statusEl) statusEl.textContent = '';
  if (btn) { btn.disabled = false; btn.textContent = 'Find Opponent'; }
  startMatch({
    id:         match_id,
    matchId:    match_id,
    name:       opponent?.name || 'Opponent',
    distance:   STATE.profile?.preferredDist || '30m',
    scoring:    'total',
    arrowCount: STATE.arrowCount,
  });
});

EventBus.on(EVENT_TYPES.WS_MM_CANCELLED, () => {
  const btn = document.querySelector('.find-btn');
  if (btn?.disabled) _fallbackFindOpponent();
});

// ── Quick Find ────────────────────────────────────────────────────────────────

function findOpponent() {
  if (!STATE.profile) { showToast('Complete your profile first', 'error'); showScene('settings'); return; }
  const btn = document.querySelector('.find-btn');
  btn.disabled    = true;
  btn.textContent = 'Searching…';
  connectMatchmaking({
    user_id:     STATE.userId,
    name:        STATE.profile.name,
    gender:      STATE.profile.gender,
    age:         STATE.profile.age,
    bow_type:    STATE.profile.bowType,
    skill_level: STATE.profile.skillLevel,
    country:     STATE.profile.country,
  });
  setTimeout(() => {
    if (document.querySelector('.find-btn')?.disabled) _fallbackFindOpponent();
  }, 15000);
}

function _fallbackFindOpponent() {
  disconnectMatchmaking();
  const statusEl = document.getElementById('find-status');
  const btn      = document.querySelector('.find-btn');
  const messages = [
    'Connecting to matchmaking…', 'Scanning for opponents…',
    'Applying filters…', 'Almost there…', 'Generating bot challenger…',
  ];
  let idx = 0;
  if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> ${messages[0]}`;
  const t = setInterval(() => {
    idx++;
    if (idx >= messages.length) {
      clearInterval(t);
      if (btn) { btn.disabled = false; btn.textContent = 'Find Opponent'; }
      if (statusEl) statusEl.textContent = '';
      startMatch(generateBotOpponent());
    } else {
      if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> ${messages[idx]}`;
    }
  }, 900);
}

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
  const list      = STATE.challenges;
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎯</div><p class="empty-text">No open challenges match your filters</p></div>`;
    return;
  }
  container.innerHTML = list.map(_renderChallengeCard).join('');
}

function _renderChallengeCard(c) {
  const name   = c.creator_name   || c.name       || 'Archer';
  const gender = c.creator_gender || c.gender      || '—';
  const age    = c.creator_age    || c.age         || '—';
  const bow    = c.creator_bow_type   || c.bowType  || '—';
  const skill  = c.creator_skill_level || c.skillLevel || '—';
  const dist   = c.distance || '—';
  const msg    = c.invite_message || c.msg || '';
  const date   = new Date(c.created_at || c.createdAt);
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
}

async function joinChallenge(id) {
  if (!STATE.profile) { showToast('Complete your profile first', 'error'); showScene('settings'); return; }
  try {
    const data = await api('POST', `/api/challenges/${id}/join`);
    if (data?.match_id) {
      startMatch({
        id:         data.challenge_id,
        matchId:    data.match_id,
        name:       data.creator_name || 'Opponent',
        scoring:    data.scoring      || 'total',
        distance:   data.distance     || '30m',
        arrowCount: data.arrow_count  || 18,
        match_type: data.match_type,
      });
      return;
    }
  } catch (e) {
    if (e.status !== 404) { showToast(e.message || 'Could not join', 'error'); return; }
  }
  const ch = STATE.challenges.find(c => c.id === id) || generateMockOpponent(id);
  startMatch({
    id:         ch.id,        matchId:    ch.matchId,
    name:       ch.creator_name || ch.name || 'Opponent',
    scoring:    ch.scoring   || 'total',
    distance:   ch.distance  || '30m',
    arrowCount: ch.arrow_count || ch.arrowCount || 18,
    match_type: ch.match_type,
  });
}

// ── New Challenge ─────────────────────────────────────────────────────────────

function selectChip(btn, group) {
  btn.closest('.chip-group').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}

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
  document.getElementById('deadline-card').classList.toggle('hidden', STATE.currentMatchType !== 'scheduled');
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

  const type      = STATE.currentMatchType;
  const scoring   = STATE.currentScoring;
  const isPrivate = document.getElementById('is-private-toggle')?.checked || false;
  const msg       = document.getElementById('invite-msg').value.trim();
  let deadline    = null;

  if (type === 'scheduled') {
    const raw = document.getElementById('challenge-deadline').value;
    if (!raw) { showToast('Set a deadline', 'error'); return; }
    deadline = new Date(raw).toISOString();
  }

  const payload = {
    match_type:     type,
    scoring,
    distance:       distChip.textContent.trim(),
    arrow_count:    STATE.arrowCount,
    invite_message: msg || null,
    deadline,
    is_private:     isPrivate,
  };

  let challengeId;
  try {
    const data = await api('POST', '/api/challenges', payload);
    challengeId = data.id;
    STATE.myChallenges.unshift(data);
  } catch {
    challengeId = `local-${Date.now()}`;
    STATE.myChallenges.unshift({ id: challengeId, ...payload, created_at: new Date().toISOString() });
    showToast('Created locally (offline)', 'info');
  }
  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));

  if (isPrivate) {
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
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  let challenges = [];
  try {
    const data = await api('GET', '/api/my-challenges');
    if (Array.isArray(data)) challenges = data;
  } catch (e) {
    console.warn('Could not load my challenges:', e.message);
  }

  STATE.myChallenges = challenges;
  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(challenges));

  // Sync active match state from server
  for (const ch of challenges) {
    if (!ch.match_id || ch.rematch_pending) continue;
    const existing = STATE.activeMatches[ch.match_id];
    STATE.activeMatches[ch.match_id] = {
      arrowValues:    existing?.arrowValues    || [],
      setArrowValues: existing?.setArrowValues || [],
      setMyScore:     existing?.setMyScore     || 0,
      setOppScore:    existing?.setOppScore    || 0,
      currentSet:     existing?.currentSet     || 1,
      id: ch.match_id, challengeId: ch.id,
      myName:  STATE.profile?.name || 'You', oppName: ch.opponent_name || 'Opponent',
      scoring: ch.scoring, arrowCount: ch.arrow_count || 18, dist: ch.distance,
      matchType: ch.match_type, discipline: ch.discipline || 'target',
      isBot: false, isCreator: ch.is_creator ?? true, complete: false, firstToAct: null,
      challengeKind: 'normal',
      _tiebreakRequired: ch.tiebreak_required || false,
      _tiebreakMatchId:  ch.tiebreak_match_id || null,
    };
  }

  const serverMatchIds = new Set(challenges.filter(c => c.match_id).map(c => c.match_id));
  for (const [mid, ms] of Object.entries(STATE.activeMatches)) {
    if (!ms.isBot && !serverMatchIds.has(mid)) ms.complete = true;
  }
  saveMatchState();
  EventBus.emit(EVENT_TYPES.APP_ACTIVE_MATCHES_CHANGED, {
    activeMatches: STATE.activeMatches, currentMatchId: STATE.currentMatchId,
  });

  if (challenges.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">◈</div><p class="empty-text">No challenges yet. Create one!</p></div>`;
    return;
  }

  container.innerHTML = challenges.map(_renderMyChCard).join('')
    || `<div class="empty-state"><div class="empty-icon">◈</div><p class="empty-text">No challenges yet. Create one!</p></div>`;
}

function _renderMyChCard(ch) {
  const scoring  = ch.scoring || 'total';
  const dist     = ch.distance || '—';
  const arrows   = ch.arrow_count;
  const title    = `${dist} · ${scoring === 'sets' ? 'Set System' : (arrows + ' arrows')}`;
  const typeTag  = escHtml(ch.match_type || '—');

  // Rematch pending card
  if (ch.rematch_pending && ch.match_id) {
    const oppName    = escHtml(ch.opponent_name || 'Opponent');
    const matchId    = escHtml(ch.match_id);
    const isProposer = ch.is_creator;
    const actionRow  = isProposer
      ? `<div class="active-match-row waiting-row">
           <span class="active-match-label">⏳ Waiting for ${oppName} to accept…</span>
         </div>`
      : `<div class="rematch-pending-row">
           <span class="active-match-label">🏹 ${oppName} wants a rematch</span>
           <div class="rematch-pending-actions">
             <button class="btn-sm btn-primary-sm" onclick="acceptRematchFromList('${matchId}')">Accept</button>
             <button class="btn-sm btn-danger"     onclick="declineRematchFromList('${matchId}')">Decline</button>
           </div>
         </div>`;
    return `
    <div class="my-ch-card has-active-match rematch-pending-card">
      <div class="my-ch-header">
        <span class="my-ch-title">Rematch · ${title}</span>
        <span class="my-ch-type">${typeTag}</span>
      </div>
      ${actionRow}
    </div>`;
  }

  let actionRow = '';
  if (ch.match_id) {
    const oppName = escHtml(ch.opponent_name || '');
    const tbLabel = ch.tiebreak_required ? ' 🎯 Tiebreak' : '';
    const matchId = escHtml(ch.match_id);
    actionRow = `
    <div class="active-match-row" onclick="switchToMatch('${matchId}')">
      <span class="active-match-label">vs ${oppName}${tbLabel}</span>
      <button class="active-match-resume" onclick="switchToMatch('${matchId}');event.stopPropagation()">Resume →</button>
    </div>`;
  } else if (ch.is_active) {
    actionRow = `
    <div class="active-match-row waiting-row" onclick="openWaitingChallenge('${ch.id}')">
      <span class="active-match-label"><span class="spinner"></span> Waiting for opponent…</span>
      <button class="active-match-resume" onclick="openWaitingChallenge('${ch.id}');event.stopPropagation()">Open →</button>
    </div>`;
  }

  const actions = `
    <div class="my-ch-actions">
      ${ch.is_private ? `<button class="btn-sm btn-copy" onclick="copyPrivateLink('${ch.id}')">Copy Link</button>` : ''}
      <button class="btn-sm btn-danger" onclick="deleteChallenge('${ch.id}')">Delete</button>
    </div>`;

  return `
  <div class="my-ch-card${ch.match_id ? ' has-active-match' : ''}">
    <div class="my-ch-header">
      <span class="my-ch-title">${title}</span>
      <span class="my-ch-type">${typeTag}</span>
    </div>
    ${actionRow}
    ${!ch.match_id ? actions : ''}
  </div>`;
}

async function acceptRematchFromList(rematchMatchId) {
  try {
    const data = await api('POST', `/api/matches/${rematchMatchId}/rematch/accept`);
    if (data?.new_match_id) {
      const prev = STATE.lastCompletedMatch || {};
      startMatch({
        id:         data.new_challenge_id || `rematch-${Date.now()}`,
        matchId:    data.new_match_id,
        name:       data.opponent_name || prev.oppName || 'Opponent',
        scoring:    data.scoring       || prev.scoring || 'total',
        distance:   data.distance      || prev.dist    || '30m',
        arrowCount: data.arrow_count   || prev.arrowCount || 18,
        match_type: data.match_type    || 'live',
      });
    }
  } catch (e) {
    showToast(e.message || 'Could not accept rematch', 'error');
  }
}

async function declineRematchFromList(rematchMatchId) {
  try {
    await api('POST', `/api/matches/${rematchMatchId}/rematch/decline`);
    showToast('Rematch declined', 'info');
    refreshMyChallenges();
  } catch (e) {
    showToast(e.message || 'Could not decline rematch', 'error');
  }
}

function openWaitingChallenge(challengeId) {
  const ch = STATE.myChallenges.find(c => c.id === challengeId);
  if (!ch) return;
  const existingMs = Object.values(STATE.activeMatches).find(
    ms => !ms.complete && (ms.challengeId === challengeId || ms.id === challengeId)
  );
  if (!existingMs) {
    startMatch({
      id: challengeId, name: 'Waiting for opponent…',
      distance: ch.distance || '30m', scoring: ch.scoring || 'total',
      arrowCount: ch.arrow_count || 18, match_type: ch.match_type,
    }, true);
  } else {
    switchToMatch(existingMs.id);
  }
}

async function deleteChallenge(id) {
  try {
    await api('DELETE', `/api/challenges/${id}`);
    STATE.myChallenges = STATE.myChallenges.filter(c => c.id !== id);
    localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));
    showToast('Challenge deleted', 'info');
    refreshMyChallenges();
  } catch (e) {
    showToast(e.message || 'Delete failed', 'error');
  }
}

function copyPrivateLink(id) {
  copyToClipboard(buildChallengeLink(id));
  showToast('Link copied!', 'success');
}

// ── Invite link handler ───────────────────────────────────────────────────────

async function handleChallengeLink(code) {
  showToast('Opening challenge…', 'info');
  showUI();
  try {
    const ch = await api('GET', `/api/challenges/${code}`);
    if (ch) {
      if (ch.creator_id === STATE.userId) {
        showToast('This is your own challenge — you cannot join it as an opponent', 'error');
        showScene('my-challenges');
        return;
      }
      if (ch.is_active !== false) {
        try {
          const joined = await api('POST', `/api/challenges/${ch.id}/join`);
          if (joined?.match_id) {
            startMatch({
              id:         joined.challenge_id,   matchId:    joined.match_id,
              name:       joined.creator_name || ch.creator_name || 'Challenger',
              scoring:    joined.scoring      || ch.scoring      || 'total',
              distance:   joined.distance     || ch.distance     || '30m',
              arrowCount: joined.arrow_count  || ch.arrow_count  || 18,
              match_type: joined.match_type   || ch.match_type,
            });
            return;
          }
        } catch (joinErr) {
          if (joinErr?.status === 400) {
            showToast(joinErr.message || 'Cannot join this challenge', 'error');
            showScene('list-challenge');
            return;
          }
        }
      }
    }
    startMatch({
      id: code, name: 'Challenger', distance: '30m', scoring: 'total', arrowCount: 18,
    });
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

function _challengePassesFilters(ch) {
  const f = STATE.filters;
  if (f.skill.length  && !f.skill.includes(ch.creator_skill_level))  return false;
  if (f.gender.length && !f.gender.includes(ch.creator_gender))       return false;
  if (f.bow.length    && !f.bow.includes(ch.creator_bow_type))        return false;
  if (f.dist.length   && !f.dist.includes(ch.distance))               return false;
  if (f.country       && ch.creator_country !== f.country)            return false;
  return true;
}

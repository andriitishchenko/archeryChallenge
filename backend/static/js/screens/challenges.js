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
      // Use challenge fields returned directly by the server — do NOT rely on
      // STATE.challenges which may have been removed by the feed WS already.
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

  // Offline fallback — challenge data from local state or mock
  const ch = STATE.challenges.find(c => c.id === id) || generateMockOpponent(id);
  startMatch({
    id:         ch.id,
    matchId:    ch.matchId,
    name:       ch.creator_name || ch.name || 'Opponent',
    scoring:    ch.scoring      || 'total',
    distance:   ch.distance     || '30m',
    arrowCount: ch.arrow_count  || ch.arrowCount || 18,
    match_type: ch.match_type,
  });
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
    // Open the waiting socket BEFORE calling startMatch so notify_user() can
    // reach the creator when an opponent joins. The socket is registered in
    // manager._user_sockets[creator_id] via register_creator_waiting().
    _openCreatorWaitSocket(challengeId, {
      distance: distChip.textContent.trim(),
      scoring,
      arrowCount: STATE.arrowCount,
    });
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

  // Fetch both my challenges (creator) and active matches (both participants) in parallel
  const [challengesRes, activeMatchesRes] = await Promise.allSettled([
    api('GET', '/api/challenges/mine'),
    api('GET', '/api/matches/mine/active'),
  ]);

  if (challengesRes.status === 'fulfilled' && challengesRes.value) {
    STATE.myChallenges = challengesRes.value;
    localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));
  }

  // Build a lookup of active server matches by challenge_id for fast join
  const serverActiveMatches = (activeMatchesRes.status === 'fulfilled' && activeMatchesRes.value)
    ? activeMatchesRes.value : [];
  const activeByChallenge = {};   // challenge_id -> ActiveMatchOut
  const activeOrphans     = [];   // matches without a challenge (e.g. matchmaking)
  for (const sm of serverActiveMatches) {
    if (sm.challenge_id) activeByChallenge[sm.challenge_id] = sm;
    else                 activeOrphans.push(sm);
  }

  // Merge server active matches into STATE.activeMatches so resume works
  for (const sm of serverActiveMatches) {
    if (!STATE.activeMatches[sm.match_id]) {
      STATE.activeMatches[sm.match_id] = {
        id:            sm.match_id,
        challengeId:   sm.challenge_id,
        myName:        STATE.profile?.name || 'You',
        oppName:       sm.opponent_name,
        scoring:       sm.scoring,
        arrowCount:    sm.arrow_count || 18,
        dist:          sm.distance,
        isBot:         false,
        isCreator:     sm.is_creator,
        complete:      false,
        arrowValues:   [],
        setArrowValues: [],
        setMyScore:    0,
        setOppScore:   0,
        currentSet:    1,
      };
    }
  }
  _updateResumeTab();

  if (STATE.myChallenges.length === 0 && serverActiveMatches.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">◈</div><p class="empty-text">No challenges yet. Create one!</p></div>`;
    return;
  }

  // Build cards for my created challenges
  const challengeCards = STATE.myChallenges.map(ch => {
    const type    = ch.match_type || ch.type || '—';
    const scoring = ch.scoring || 'total';
    const dist    = ch.distance || '—';
    const arrows  = ch.arrow_count || ch.arrowCount;
    const isPriv  = ch.is_private === true || ch.isPrivate === true || ch.match_type === 'private';

    // Find active match: prefer server data, fall back to client STATE
    const serverMatch = activeByChallenge[ch.id];
    const stateMatch  = Object.values(STATE.activeMatches).find(
      ms => !ms.complete && (ms.challengeId === ch.id || ms.id === ch.id)
    );
    const activeMs = serverMatch
      ? STATE.activeMatches[serverMatch.match_id] || stateMatch
      : stateMatch;

    const matchId  = activeMs?.id || serverMatch?.match_id;
    const oppName  = activeMs?.oppName || serverMatch?.opponent_name || '';

    const activeRow = matchId ? `
      <div class="active-match-row" onclick="switchToMatch('${escHtml(matchId)}')">
        <span class="active-match-label">Live vs ${escHtml(oppName)}</span>
        <button class="active-match-resume" onclick="switchToMatch('${escHtml(matchId)}');event.stopPropagation()">Resume →</button>
      </div>` : '';

    return `
    <div class="my-ch-card${matchId ? ' has-active-match' : ''}">
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
  });

  // Build cards for active matches where I am the JOINER (no challenge card)
  const joinerCards = serverActiveMatches
    .filter(sm => !sm.is_creator && !STATE.myChallenges.find(ch => ch.id === sm.challenge_id))
    .map(sm => {
      const matchId = sm.match_id;
      const oppName = sm.opponent_name;
      return `
    <div class="my-ch-card has-active-match">
      <div class="my-ch-header">
        <span class="my-ch-title">${sm.distance} · ${sm.scoring === 'sets' ? 'Set System' : (sm.arrow_count + ' arrows')}</span>
        <span class="my-ch-type">${sm.match_type}</span>
      </div>
      <div class="active-match-row" onclick="switchToMatch('${escHtml(matchId)}')">
        <span class="active-match-label">Live vs ${escHtml(oppName)}</span>
        <button class="active-match-resume" onclick="switchToMatch('${escHtml(matchId)}');event.stopPropagation()">Resume →</button>
      </div>
      <div class="my-ch-actions">
        <span class="ch-tag">Joined</span>
      </div>
    </div>`;
    });

  const allCards = [...challengeCards, ...joinerCards];
  container.innerHTML = allCards.length
    ? allCards.join('')
    : `<div class="empty-state"><div class="empty-icon">◈</div><p class="empty-text">No challenges yet. Create one!</p></div>`;
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

// ── Challenge invite link (URL param ?c=...) ──────────────────────────────────

async function handleChallengeLink(code) {
  showToast('Opening challenge…', 'info');
  showUI();
  try {
    const ch = await api('GET', `/api/challenges/${code}`);
    if (ch) {
      // Block joining own challenge: server rejects with 400 but we check
      // client-side first for a clear immediate error message.
      if (ch.creator_id === STATE.userId) {
        showToast('This is your own challenge — you cannot join it as an opponent', 'error');
        showScene('my-challenges');
        return;
      }

      if (ch.is_active !== false) {
        try {
          const joined = await api('POST', `/api/challenges/${ch.id}/join`);
          if (joined?.match_id) {
            // Use fields from the enriched JoinResponse — authoritative source
            startMatch({
              id:         joined.challenge_id,
              matchId:    joined.match_id,
              name:       joined.creator_name || ch.creator_name || 'Challenger',
              scoring:    joined.scoring      || ch.scoring      || 'total',
              distance:   joined.distance     || ch.distance     || '30m',
              arrowCount: joined.arrow_count  || ch.arrow_count  || 18,
              match_type: joined.match_type   || ch.match_type,
            });
            return;
          }
        } catch (joinErr) {
          // Surface server-side rejections clearly instead of silently going offline
          if (joinErr?.status === 400) {
            showToast(joinErr.message || 'Cannot join this challenge', 'error');
            showScene('list-challenge');
            return;
          }
        }
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

// ── Creator waiting socket ────────────────────────────────────────────────────

// Tracks the open waiting socket so it can be closed when no longer needed
let _creatorWaitSocket = null;

/**
 * Open WS /ws/challenge/{challengeId}/wait so the server can push
 * opponent_joined to the creator with the real match_id.
 * Called immediately after creating a live challenge.
 *
 * @param {string} challengeId  The challenge ID returned from POST /api/challenges
 * @param {object} matchParams  { distance, scoring, arrowCount } for startMatch on join
 */
function _openCreatorWaitSocket(challengeId, matchParams) {
  if (_creatorWaitSocket) {
    _creatorWaitSocket.close();
    _creatorWaitSocket = null;
  }

  try {
    _creatorWaitSocket = new WebSocket(
      `${WS_BASE}/ws/challenge/${challengeId}/wait?token=${STATE.accessToken || ''}`
    );

    _creatorWaitSocket.onopen = () => {
      // Keep alive
      _creatorWaitSocket._ping = setInterval(() => {
        if (_creatorWaitSocket?.readyState === WebSocket.OPEN)
          _creatorWaitSocket.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
    };

    _creatorWaitSocket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'opponent_joined') {
        // Close the waiting socket — we're transitioning to a live match socket
        closeCreatorWaitSocket();

        const ms = STATE.activeMatches[challengeId];
        if (ms) {
          // Migrate the pending match state to the real server match_id
          const realMatchId  = msg.match_id;
          const opponentName = msg.opponent_name || 'Opponent';

          ms.id      = realMatchId;
          ms.oppName = opponentName;
          ms._opponentJoined = true;

          // Cancel bot fallback before re-keying so the timer closure
          // (keyed on challengeId) can be cleared explicitly
          if (typeof _botFallbackTimers !== 'undefined' && _botFallbackTimers[challengeId]) {
            clearTimeout(_botFallbackTimers[challengeId]);
            delete _botFallbackTimers[challengeId];
          }

          STATE.activeMatches[realMatchId] = ms;
          delete STATE.activeMatches[challengeId];
          if (STATE.currentMatchId === challengeId) STATE.currentMatchId = realMatchId;

          saveMatchState();

          // Re-render the full match scene so ALL name elements update,
          // including #set-opp-name used in set-scoring mode.
          if (STATE.currentMatchId === realMatchId) renderMatchScene();

          // Open the real per-match WebSocket now that we have a match_id
          _connectMatchSocket(realMatchId);
          _startBgStatusPoll();

          showToast(`${opponentName} joined your challenge!`, 'success');
        }
      }
    };

    _creatorWaitSocket.onerror = () => {
      // Non-fatal — bot fallback timer still runs
    };

    _creatorWaitSocket.onclose = () => {
      if (_creatorWaitSocket?._ping) clearInterval(_creatorWaitSocket._ping);
    };

  } catch (err) {
    console.warn('Could not open creator wait socket:', err);
  }
}

function closeCreatorWaitSocket() {
  if (_creatorWaitSocket) {
    if (_creatorWaitSocket._ping) clearInterval(_creatorWaitSocket._ping);
    _creatorWaitSocket.close();
    _creatorWaitSocket = null;
  }
}

// ── Challenge feed WebSocket (real-time list updates) ─────────────────────────

let _challengeFeedSocket = null;

/**
 * Connect to WS /ws/challenges to receive real-time challenge list updates.
 * Called on login/session restore. Reconnects automatically on unexpected close.
 */
function connectChallengeFeed() {
  if (_challengeFeedSocket &&
      (_challengeFeedSocket.readyState === WebSocket.OPEN ||
       _challengeFeedSocket.readyState === WebSocket.CONNECTING)) return;

  try {
    _challengeFeedSocket = new WebSocket(
      `${WS_BASE}/ws/challenges?token=${STATE.accessToken || ''}`
    );

    _challengeFeedSocket.onopen = () => {
      _challengeFeedSocket._ping = setInterval(() => {
        if (_challengeFeedSocket?.readyState === WebSocket.OPEN)
          _challengeFeedSocket.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };

    _challengeFeedSocket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'new_challenge') {
        const ch = msg.challenge;
        // Ignore own challenges — server already excludes them in the REST list
        // but WS broadcasts to everyone; the creator_id check guards correctly.
        if (ch.creator_id === STATE.userId) return;

        // Apply active filters before inserting
        if (!_challengePassesFilters(ch)) return;

        // Prepend to state and re-render only if list screen is active
        STATE.challenges.unshift(ch);
        if (STATE.currentScene === 'list-challenge') renderChallengeList();

      } else if (msg.type === 'challenge_removed') {
        const idx = STATE.challenges.findIndex(c => c.id === msg.challenge_id);
        if (idx !== -1) {
          STATE.challenges.splice(idx, 1);
          if (STATE.currentScene === 'list-challenge') renderChallengeList();
        }
      }
    };

    _challengeFeedSocket.onerror = () => {};

    _challengeFeedSocket.onclose = (e) => {
      if (_challengeFeedSocket?._ping) clearInterval(_challengeFeedSocket._ping);
      _challengeFeedSocket = null;
      // Reconnect after 5 s unless intentionally closed (code 1000)
      if (e.code !== 1000 && STATE.accessToken) {
        setTimeout(connectChallengeFeed, 5000);
      }
    };

  } catch (err) {
    console.warn('Challenge feed WS unavailable:', err);
  }
}

function disconnectChallengeFeed() {
  if (_challengeFeedSocket) {
    _challengeFeedSocket.close(1000);
    _challengeFeedSocket = null;
  }
}

/**
 * Check whether a challenge from the feed passes the user's current filters.
 * Mirrors the server-side filter logic so we don't show cards the REST list
 * would have hidden.
 */
function _challengePassesFilters(ch) {
  const f = STATE.filters;
  if (f.skill.length  && !f.skill.includes(ch.creator_skill_level))  return false;
  if (f.gender.length && !f.gender.includes(ch.creator_gender))       return false;
  if (f.bow.length    && !f.bow.includes(ch.creator_bow_type))        return false;
  if (f.dist.length   && !f.dist.includes(ch.distance))               return false;
  if (f.country       && ch.creator_country !== f.country)            return false;
  return true;
}

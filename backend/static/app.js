// =============================================
// ARROWMATCH — Archery Challenge Platform
// Frontend Application Logic
// All API calls go through the api() helper.
// =============================================

// ==================== CONFIG ====================
const API_BASE = '';   // same-origin: backend serves index.html at /
const WS_BASE  = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ==================== STATE ====================
const STATE = {
  userId: null,
  accessToken: null,
  refreshToken: null,
  user: null,           // { email, isGuest }
  profile: null,        // { name, gender, age, bowType, skillLevel, country }
  currentScene: 'entry',
  activeChallengeId: null,
  currentMatchType: 'live',
  currentScoring: 'total',
  arrowCount: 18,
  matchState: null,
  challenges: [],
  myChallenges: [],
  history: [],
  filters: {
    skill: ['Beginner', 'Skilled', 'Master'],
    gender: ['Male', 'Female'],
    bow: ['Recurve', 'Compound', 'Barebow'],
    dist: ['18m', '25m', '30m', '50m', '70m', '90m'],
    country: ''
  }
};

// Score input globals
let activeArrowIndex = 0;
let arrowValues = [];
let findingTimer = null;
let matchSocket = null;    // WebSocket for live match
let mmSocket = null;       // WebSocket for matchmaking

// ==================== API LAYER ====================

/**
 * Central API helper.
 * Handles auth headers, token refresh on 401, and JSON parsing.
 * Falls back to localStorage cache on network error.
 */
async function api(method, path, body = null, { skipAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!skipAuth && STATE.accessToken) {
    headers['Authorization'] = `Bearer ${STATE.accessToken}`;
  }

  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
  } catch (err) {
    // Network offline — return null, callers fall back to local state
    console.warn('API offline:', path, err.message);
    return null;
  }

  // 401 → attempt token refresh once
  if (resp.status === 401 && STATE.refreshToken && !skipAuth) {
    const refreshed = await _tryRefresh();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${STATE.accessToken}`;
      resp = await fetch(`${API_BASE}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : null,
      });
    } else {
      _clearSession();
      showScene('entry');
      showToast('Session expired. Please sign in again.', 'error');
      return null;
    }
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try { detail = (await resp.json()).detail || detail; } catch {}
    throw new ApiError(detail, resp.status);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function _tryRefresh() {
  try {
    const data = await api('POST', '/api/auth/refresh',
      { refresh_token: STATE.refreshToken }, { skipAuth: true });
    if (data) {
      _storeTokens(data.access_token, data.refresh_token);
      return true;
    }
  } catch {}
  return false;
}

function _storeTokens(access, refresh) {
  STATE.accessToken = access;
  STATE.refreshToken = refresh;
  localStorage.setItem('arrowmatch_access_token', access);
  if (refresh) localStorage.setItem('arrowmatch_refresh_token', refresh);
}

function _clearSession() {
  STATE.userId = null;
  STATE.accessToken = null;
  STATE.refreshToken = null;
  STATE.user = null;
  STATE.profile = null;
  localStorage.removeItem('arrowmatch_access_token');
  localStorage.removeItem('arrowmatch_refresh_token');
  localStorage.removeItem('arrowmatch_userid');
  localStorage.removeItem('arrowmatch_user');
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', init);

function init() {
  loadCountries();
  restoreSession();
  setupInviteMessageCounter();
}

async function restoreSession() {
  const savedUserId     = localStorage.getItem('arrowmatch_userid');
  const savedAccess     = localStorage.getItem('arrowmatch_access_token');
  const savedRefresh    = localStorage.getItem('arrowmatch_refresh_token');
  const savedUser       = localStorage.getItem('arrowmatch_user');
  const savedProfile    = localStorage.getItem('arrowmatch_profile');
  const savedMyCh       = localStorage.getItem('arrowmatch_my_challenges');
  const savedHistory    = localStorage.getItem('arrowmatch_history');
  const savedMatchState = localStorage.getItem('arrowmatch_match_state');

  if (savedMyCh)    STATE.myChallenges = JSON.parse(savedMyCh);
  if (savedHistory) STATE.history      = JSON.parse(savedHistory);

  // Check for challenge link
  const urlParams     = new URLSearchParams(window.location.search);
  const challengeCode = urlParams.get('c');

  if (savedUserId && savedAccess) {
    STATE.userId      = savedUserId;
    STATE.accessToken = savedAccess;
    STATE.refreshToken = savedRefresh || null;
    if (savedUser)    STATE.user    = JSON.parse(savedUser);
    if (savedProfile) STATE.profile = JSON.parse(savedProfile);

    // Verify token is still valid by fetching profile from server
    try {
      const serverProfile = await api('GET', '/api/profile');
      if (serverProfile) {
        STATE.profile = _serverProfileToLocal(serverProfile);
        localStorage.setItem('arrowmatch_profile', JSON.stringify(STATE.profile));
      }
    } catch (e) {
      if (e.status === 401) { _clearSession(); showScene('entry'); return; }
      // Other error (network) — continue with cached profile
    }

    showUI();

    if (challengeCode) {
      handleChallengeLink(challengeCode);
    } else if (savedMatchState) {
      STATE.matchState = JSON.parse(savedMatchState);
      showScene('challenge');
      restoreMatch();
      showToast('Match restored from previous session', 'info');
    } else {
      showScene('list-challenge');
    }
  } else {
    showScene('entry');
  }
}

function showUI() {
  document.getElementById('topnav').classList.remove('hidden');
  document.getElementById('bottomnav').classList.remove('hidden');
  updateNavTitle();
}

// ==================== AUTH ====================

async function handleGuest() {
  try {
    const data = await api('POST', '/api/guest', null, { skipAuth: true });
    if (data) {
      STATE.userId = data.user_id;
      STATE.user   = { isGuest: true, email: null };
      _storeTokens(data.access_token, data.refresh_token);
      localStorage.setItem('arrowmatch_userid', data.user_id);
      localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));
    } else {
      // Offline fallback
      STATE.userId = _generateLocalId();
      STATE.user   = { isGuest: true, email: null };
      localStorage.setItem('arrowmatch_userid', STATE.userId);
      localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));
    }
    showUI();
    showScene('settings');
    showToast('Welcome! Please fill in your profile.', 'info');
  } catch (e) {
    showToast(e.message || 'Could not connect. Try again.', 'error');
  }
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  if (!email || !pass) { showToast('Enter email and password', 'error'); return; }
  if (!validateEmail(email)) { showToast('Invalid email', 'error'); return; }

  try {
    const data = await api('POST', '/api/auth/login',
      { email, password: pass }, { skipAuth: true });
    STATE.userId = data.user_id;
    STATE.user   = { isGuest: data.is_guest, email };
    _storeTokens(data.access_token, data.refresh_token);
    localStorage.setItem('arrowmatch_userid', data.user_id);
    localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));

    // Fetch profile from server
    try {
      const p = await api('GET', '/api/profile');
      if (p) {
        STATE.profile = _serverProfileToLocal(p);
        localStorage.setItem('arrowmatch_profile', JSON.stringify(STATE.profile));
      }
    } catch {}

    showUI();
    showScene('list-challenge');
    showToast('Welcome back!', 'success');
  } catch (e) {
    showToast(e.message || 'Login failed', 'error');
  }
}

async function handleRegister() {
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-password').value;
  if (!email || !pass) { showToast('Enter email and password', 'error'); return; }
  if (!validateEmail(email)) { showToast('Invalid email', 'error'); return; }
  if (pass.length < 8) { showToast('Password min 8 characters', 'error'); return; }

  try {
    const data = await api('POST', '/api/auth/register',
      { email, password: pass, existing_user_id: STATE.userId || null },
      { skipAuth: true });
    STATE.userId = data.user_id;
    STATE.user   = { isGuest: false, email };
    _storeTokens(data.access_token, data.refresh_token);
    localStorage.setItem('arrowmatch_userid', data.user_id);
    localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));
    showUI();
    showScene('settings');
    showToast('Account created! Fill in your profile.', 'success');
  } catch (e) {
    showToast(e.message || 'Registration failed', 'error');
  }
}

async function handleCreateAccount() {
  const email = document.getElementById('acc-email').value.trim();
  const pass  = document.getElementById('acc-password').value;
  if (!email || !pass) { showToast('Enter email and password', 'error'); return; }
  if (!validateEmail(email)) { showToast('Invalid email', 'error'); return; }
  if (pass.length < 8) { showToast('Password min 8 chars', 'error'); return; }

  try {
    const data = await api('POST', '/api/auth/register',
      { email, password: pass, existing_user_id: STATE.userId },
      { skipAuth: true });
    STATE.user = { isGuest: false, email };
    _storeTokens(data.access_token, data.refresh_token);
    localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));
    updateSettingsAccountSection();
    showToast('Account linked!', 'success');
  } catch (e) {
    showToast(e.message || 'Failed to create account', 'error');
  }
}

function handleLogout() {
  _clearSession();
  localStorage.clear();
  location.reload();
}

function toggleRegister() {
  document.getElementById('entry-form-login').classList.toggle('hidden');
  document.getElementById('entry-form-register').classList.toggle('hidden');
}

// ==================== SCENE NAVIGATION ====================

function showScene(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scene === name);
  });
  document.querySelectorAll('.scene').forEach(s => s.classList.remove('active'));
  const scene = document.getElementById(`scene-${name}`);
  if (!scene) return;
  scene.classList.add('active');
  STATE.currentScene = name;
  updateNavTitle();

  if (name === 'list-challenge')  refreshChallengeList();
  if (name === 'my-challenges')   refreshMyChallenges();
  if (name === 'history')         refreshHistory();
  if (name === 'settings')        refreshSettings();
  if (name === 'new-challenge')   updateDeadlineVisibility();

  document.getElementById('back-btn').classList.toggle('hidden',
    !['challenge'].includes(name));
}

function goBack() { showScene('list-challenge'); }

function updateNavTitle() {
  const titles = {
    entry: '', settings: 'Settings',
    'list-challenge': 'ArrowMatch', 'new-challenge': 'New Challenge',
    'my-challenges': 'My Challenges', challenge: 'Match', history: 'History'
  };
  const el = document.getElementById('nav-title');
  if (el) el.textContent = titles[STATE.currentScene] || '';
  const isEntry = STATE.currentScene === 'entry';
  document.getElementById('topnav').classList.toggle('hidden', isEntry);
  document.getElementById('bottomnav').classList.toggle('hidden', isEntry);
}

// ==================== SETTINGS ====================

function refreshSettings() {
  if (!STATE.profile) return;
  const p = STATE.profile;
  if (p.name) document.getElementById('s-name').value = p.name;
  if (p.gender) {
    document.querySelectorAll('input[name="gender"]').forEach(r => {
      r.checked = r.value === p.gender;
    });
  }
  if (p.age) document.getElementById('s-age').value = p.age;
  if (p.bowType) {
    document.querySelectorAll('#bow-type-chips .chip').forEach(c => {
      c.classList.toggle('active', c.textContent.trim() === p.bowType);
    });
  }
  if (p.skillLevel) {
    document.querySelectorAll('#skill-level-chips .chip').forEach(c => {
      c.classList.toggle('active', c.textContent.trim() === p.skillLevel);
    });
  }
  if (p.country) document.getElementById('s-country').value = p.country;
  document.getElementById('display-user-id').textContent = STATE.userId || '—';
  updateSettingsAccountSection();
}

function updateSettingsAccountSection() {
  const isGuest = !STATE.user || STATE.user.isGuest;
  document.getElementById('account-section-guest').classList.toggle('hidden', !isGuest);
  document.getElementById('account-section-user').classList.toggle('hidden', isGuest);
  if (!isGuest && STATE.user?.email) {
    document.getElementById('acc-display-email').textContent = STATE.user.email;
  }
}

async function saveSettings() {
  const name      = document.getElementById('s-name').value.trim();
  const genderEl  = document.querySelector('input[name="gender"]:checked');
  const age       = document.getElementById('s-age').value;
  const bowChip   = document.querySelector('#bow-type-chips .chip.active');
  const skillChip = document.querySelector('#skill-level-chips .chip.active');
  const country   = document.getElementById('s-country').value;

  if (!name)      { showToast('Name is required', 'error'); return; }
  if (!genderEl)  { showToast('Select gender', 'error'); return; }
  if (!age)       { showToast('Select age range', 'error'); return; }
  if (!bowChip)   { showToast('Select bow type', 'error'); return; }
  if (!skillChip) { showToast('Select skill level', 'error'); return; }
  if (!country)   { showToast('Select country', 'error'); return; }

  const profile = {
    name,
    gender: genderEl.value,
    age,
    bowType: bowChip.textContent.trim(),
    skillLevel: skillChip.textContent.trim(),
    country,
  };

  // Save locally immediately (offline-safe)
  STATE.profile = profile;
  localStorage.setItem('arrowmatch_profile', JSON.stringify(profile));

  // Sync to server
  try {
    await api('PUT', '/api/profile', {
      name:        profile.name,
      gender:      profile.gender,
      age:         profile.age,
      bow_type:    profile.bowType,
      skill_level: profile.skillLevel,
      country:     profile.country,
    });
    showToast('Profile saved!', 'success');
  } catch (e) {
    showToast('Saved locally (offline — will sync later)', 'info');
  }

  showScene('list-challenge');
}

// ==================== CHALLENGE LIST ====================

async function refreshChallengeList() {
  const container = document.getElementById('challenge-list');
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const f = STATE.filters;
    const params = new URLSearchParams();
    f.skill.forEach(v => params.append('skill', v));
    f.gender.forEach(v => params.append('gender', v));
    f.bow.forEach(v => params.append('bow', v));
    f.dist.forEach(v => params.append('dist', v));
    if (f.country) params.set('country', f.country);

    const data = await api('GET', `/api/challenges?${params}`);
    if (data) {
      STATE.challenges = data;
      renderChallengeList();
      return;
    }
  } catch (e) {
    console.warn('Could not load challenges from server:', e.message);
  }

  // Offline: show cached or mock
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
    // Support both server shape (creator_name etc.) and mock shape (name etc.)
    const name       = c.creator_name || c.name || 'Archer';
    const gender     = c.creator_gender || c.gender || '—';
    const age        = c.creator_age || c.age || '—';
    const bow        = c.creator_bow_type || c.bowType || '—';
    const skill      = c.creator_skill_level || c.skillLevel || '—';
    const dist       = c.distance || '—';
    const msg        = c.invite_message || c.msg || '';
    const date       = new Date(c.created_at || c.createdAt);
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
      // Find challenge for metadata
      const ch = STATE.challenges.find(c => c.id === id) || {};
      startMatch({
        ...ch,
        matchId: data.match_id,
        name: ch.creator_name || ch.name || 'Opponent',
      });
      return;
    }
  } catch (e) {
    if (e.status !== 404) { showToast(e.message || 'Could not join', 'error'); return; }
  }

  // Offline/mock fallback
  const ch = STATE.challenges.find(c => c.id === id) || generateMockOpponent(id);
  startMatch(ch);
}

// ==================== FIND OPPONENT ====================

function findOpponent() {
  if (!STATE.profile) { showToast('Complete your profile first', 'error'); showScene('settings'); return; }

  const statusEl = document.getElementById('find-status');
  const btn = document.querySelector('.find-btn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  // Try WebSocket matchmaking first
  _connectMatchmaking(statusEl, btn);
}

function _connectMatchmaking(statusEl, btn) {
  if (mmSocket) { mmSocket.close(); mmSocket = null; }

  try {
    mmSocket = new WebSocket(`${WS_BASE}/ws/matchmaking?token=${STATE.accessToken || ''}`);

    mmSocket.onopen = () => {
      statusEl.innerHTML = `<span class="spinner"></span> Searching for opponent…`;
      mmSocket.send(JSON.stringify({
        type: 'find',
        filters: STATE.filters,
        profile: {
          user_id:     STATE.userId,
          name:        STATE.profile.name,
          gender:      STATE.profile.gender,
          age:         STATE.profile.age,
          bow_type:    STATE.profile.bowType,
          skill_level: STATE.profile.skillLevel,
          country:     STATE.profile.country,
        }
      }));
    };

    mmSocket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        statusEl.innerHTML = `<span class="spinner"></span> ${escHtml(msg.message)}`;
      } else if (msg.type === 'matched') {
        statusEl.textContent = '';
        btn.disabled = false;
        btn.textContent = 'Find Opponent';
        mmSocket.close();
        startMatch({
          id: msg.match_id,
          matchId: msg.match_id,
          name: msg.opponent?.name || 'Opponent',
          distance: STATE.profile.preferredDist || '30m',
          scoring: 'total',
          arrowCount: STATE.arrowCount,
        });
      }
    };

    mmSocket.onerror = () => {
      // WS unavailable — fall back to polling / mock
      _fallbackFindOpponent(statusEl, btn);
    };

    mmSocket.onclose = (e) => {
      if (e.code !== 1000) _fallbackFindOpponent(statusEl, btn);
    };

  } catch {
    _fallbackFindOpponent(statusEl, btn);
  }
}

function _fallbackFindOpponent(statusEl, btn) {
  const messages = [
    'Connecting to matchmaking…',
    'Scanning for opponents…',
    'Applying filters…',
    'Almost there…',
    'Generating bot challenger…',
  ];
  let idx = 0;
  statusEl.innerHTML = `<span class="spinner"></span> ${messages[0]}`;
  const t = setInterval(() => {
    idx++;
    if (idx >= messages.length) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = 'Find Opponent';
      statusEl.textContent = '';
      startMatch(generateBotOpponent());
    } else {
      statusEl.innerHTML = `<span class="spinner"></span> ${messages[idx]}`;
    }
  }, 900);
}

function generateBotOpponent() {
  const names = ['BotArcher_Theta', 'AutoNock_7', 'RoboRelease', 'CyberBow_X'];
  return {
    id: `bot-${Date.now()}`,
    name: names[Math.floor(Math.random() * names.length)],
    isBot: true,
    distance: '30m',
    scoring: 'total',
    arrowCount: STATE.arrowCount,
    type: 'live',
  };
}

function generateMockOpponent(id) {
  return { id, name: 'ArcherUnknown', distance: '30m', scoring: 'total', arrowCount: 18, type: 'async' };
}

function generateMockChallenges() {
  const names  = ['SteadyHand42', 'ForestArcher', 'GoldenNock', 'QuietDraw', 'TitanBow'];
  const bows   = ['Recurve', 'Compound', 'Barebow'];
  const skills = ['Beginner', 'Skilled', 'Master'];
  const ages   = ['18–20', '21–49', '50+'];
  const dists  = ['18m', '30m', '50m', '70m'];
  const msgs   = ['Looking for a friendly match!', 'Come test your skills!', '', 'Recurve archers welcome', ''];
  return Array.from({ length: 6 }, (_, i) => ({
    id: `mock-${i}`,
    creator_name: names[i % names.length],
    creator_gender: i % 2 === 0 ? 'Male' : 'Female',
    creator_age: ages[i % 3],
    creator_bow_type: bows[i % 3],
    creator_skill_level: skills[i % 3],
    distance: dists[i % 4],
    invite_message: msgs[i % msgs.length],
    type: i % 2 === 0 ? 'live' : 'async',
    created_at: new Date(Date.now() - i * 180000).toISOString(),
  }));
}

// ==================== NEW CHALLENGE ====================

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
  document.getElementById('scoring-sets-opts').classList.toggle('hidden', STATE.currentScoring !== 'sets');
}

function changeArrows(delta) {
  STATE.arrowCount = Math.max(3, Math.min(36, STATE.arrowCount + delta));
  document.getElementById('arrows-count').textContent = STATE.arrowCount;
}

function updateDeadlineVisibility() {
  const show = ['async', 'scheduled', 'private'].includes(STATE.currentMatchType);
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

  if (['async', 'scheduled', 'private'].includes(type)) {
    const raw = document.getElementById('challenge-deadline').value;
    if (!raw) { showToast('Set a deadline', 'error'); return; }
    deadline = new Date(raw).toISOString();
  }

  const payload = {
    match_type:     type === 'async' ? 'async' : type,
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
    // Add to local myChallenges from server response
    STATE.myChallenges.unshift(data);
  } catch (e) {
    // Offline: create locally
    challengeId = `local-${Date.now()}`;
    const localCh = { id: challengeId, ...payload, isPrivate: type === 'private', created_at: new Date().toISOString() };
    STATE.myChallenges.unshift(localCh);
    showToast('Created locally (offline)', 'info');
  }

  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));

  if (type === 'private') {
    const link = buildChallengeLink(challengeId);
    copyToClipboard(link);
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

// ==================== MY CHALLENGES ====================

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
    const isPriv  = ch.is_private || ch.isPrivate;
    return `
    <div class="my-ch-card">
      <div class="my-ch-header">
        <span class="my-ch-title">${dist} · ${scoring === 'sets' ? 'Set System' : (arrows + ' arrows')}</span>
        <span class="my-ch-type">${type}</span>
      </div>
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
  try {
    await api('DELETE', `/api/challenges/${id}`);
  } catch {}
  STATE.myChallenges = STATE.myChallenges.filter(c => c.id !== id);
  localStorage.setItem('arrowmatch_my_challenges', JSON.stringify(STATE.myChallenges));
  refreshMyChallenges();
  showToast('Challenge deleted', 'info');
}

function copyPrivateLink(id) {
  copyToClipboard(buildChallengeLink(id));
  showToast('Link copied!', 'success');
}

// ==================== MATCH SCENE ====================

function startMatch(challenge, isCreator = false) {
  const myName    = STATE.profile?.name || 'You';
  const oppName   = challenge.creator_name || challenge.name || 'Opponent';
  const scoring   = challenge.scoring || 'total';
  const arrowCount = challenge.arrow_count || challenge.arrowCount || STATE.arrowCount || 18;
  const dist      = challenge.distance || '30m';

  STATE.matchState = {
    id: challenge.matchId || challenge.id,
    challengeId: challenge.id,
    myName, oppName, scoring, arrowCount, dist,
    isBot: challenge.isBot || false,
    arrowValues: [],
    setMyScore: 0, setOppScore: 0, currentSet: 1, setArrowValues: [],
    complete: false, isCreator,
  };

  saveMatchState();
  renderMatchScene();
  showScene('challenge');

  // Connect live WebSocket if we have a real matchId
  if (challenge.matchId && !challenge.isBot) {
    _connectMatchSocket(challenge.matchId);
  }
}

function _connectMatchSocket(matchId) {
  if (matchSocket) { matchSocket.close(); matchSocket = null; }
  try {
    matchSocket = new WebSocket(`${WS_BASE}/ws/match/${matchId}?token=${STATE.accessToken || ''}`);
    matchSocket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'opponent_score') {
        _onOpponentArrow(msg.arrow_index, msg.value);
      } else if (msg.type === 'opponent_complete') {
        showToast(`${STATE.matchState?.oppName} finished: ${msg.final_score}`, 'info');
      } else if (msg.type === 'opponent_disconnected') {
        showToast('Opponent disconnected', 'error');
      }
    };
  } catch {}
}

function _onOpponentArrow(arrowIndex, value) {
  // Visual indicator that opponent is scoring (could be rendered in a parallel row)
  const indicator = document.getElementById('opp-indicator');
  if (indicator) {
    indicator.textContent = `Opp: arrow ${arrowIndex + 1} = ${value}`;
    setTimeout(() => { indicator.textContent = ''; }, 2000);
  }
}

function restoreMatch() {
  if (!STATE.matchState) return;
  renderMatchScene();
  arrowValues = [...STATE.matchState.arrowValues];
  refreshArrowCells();
}

function renderMatchScene() {
  const ms = STATE.matchState;
  document.getElementById('ch-my-name').textContent  = ms.myName;
  document.getElementById('ch-opp-name').textContent = ms.oppName;
  document.getElementById('ch-dist').textContent     = ms.dist;

  const isTotal = ms.scoring === 'total';
  document.getElementById('total-score-ui').classList.toggle('hidden', !isTotal);
  document.getElementById('set-score-ui').classList.toggle('hidden', isTotal);

  if (isTotal) {
    buildArrowRows(ms.arrowCount);
    arrowValues = ms.arrowValues.length ? [...ms.arrowValues] : new Array(ms.arrowCount).fill(null);
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
}

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
      if (idx < count) {
        html += `<div class="arrow-cell" id="ac-${idx}" onclick="activateCell(${idx})"></div>`;
      } else {
        html += `<div class="arrow-cell" style="visibility:hidden"></div>`;
      }
    }
    html += `</div><span class="row-sum" id="rs-${r}"></span></div>`;
  }
  container.innerHTML = html;
}

function buildSetArrowRow() {
  const container = document.getElementById('set-arrow-row');
  container.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const cell = document.createElement('div');
    cell.className = 'arrow-cell';
    cell.id = `sac-${i}`;
    cell.onclick = () => activateSetCell(i);
    container.appendChild(cell);
  }
}

function activateCell(idx) {
  activeArrowIndex = idx;
  refreshArrowCells();
}

function activateSetCell(idx) {
  activeArrowIndex = idx;
  refreshSetArrowCells();
}

function numInput(val) {
  if (STATE.matchState?.scoring === 'sets') {
    numInputSet(val);
  } else {
    numInputTotal(val);
  }
  saveMatchState();
  // Broadcast to live opponent via WebSocket
  if (matchSocket?.readyState === WebSocket.OPEN) {
    matchSocket.send(JSON.stringify({
      type: 'score_update',
      arrow_index: activeArrowIndex,
      value: val,
    }));
  }
}

function numInputTotal(val) {
  const ms = STATE.matchState;
  if (activeArrowIndex >= ms.arrowCount) return;
  arrowValues[activeArrowIndex] = val;
  ms.arrowValues = [...arrowValues];
  const next = arrowValues.findIndex((v, i) => i > activeArrowIndex && v === null);
  activeArrowIndex = next === -1 ? ms.arrowCount - 1 : next;
  refreshArrowCells();
  updateTotalSum();
  checkTotalComplete();
}

function numInputSet(val) {
  if (activeArrowIndex >= 3) return;
  arrowValues[activeArrowIndex] = val;
  STATE.matchState.setArrowValues = [...arrowValues];
  const next = arrowValues.findIndex((v, i) => i > activeArrowIndex && v === null);
  activeArrowIndex = next === -1 ? 2 : next;
  refreshSetArrowCells();
  if (arrowValues.every(v => v !== null)) setTimeout(resolveSet, 400);
}

function numDel() {
  if (STATE.matchState?.scoring === 'sets') numDelSet();
  else numDelTotal();
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
  ms.arrowValues = [...arrowValues];
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
  arrowValues[target] = null;
  STATE.matchState.setArrowValues = [...arrowValues];
  activeArrowIndex = target;
  refreshSetArrowCells();
}

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
      if (v === 10) cell.classList.add('filled-10');
      else if (v === 9) cell.classList.add('filled-9');
      else if (v === 8) cell.classList.add('filled-8');
      else cell.classList.add('filled');
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
    if (rsEl) rsEl.textContent = filled.length === (end - start) ? filled.reduce((a, b) => a + b, 0) : '';
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
      if (v === 10) cell.classList.add('filled-10');
      else if (v === 9) cell.classList.add('filled-9');
      else if (v === 8) cell.classList.add('filled-8');
      else cell.classList.add('filled');
    } else {
      cell.textContent = '';
    }
  }
}

function updateTotalSum() {
  const sum = arrowValues.filter(v => v !== null).reduce((a, b) => a + b, 0);
  document.getElementById('total-sum').textContent = sum;
}

function checkTotalComplete() {
  const ms = STATE.matchState;
  if (arrowValues.every(v => v !== null)) {
    const myScore = arrowValues.reduce((a, b) => a + b, 0);
    _submitScoreToServer(arrowValues);
    const botScore = Math.round(myScore + (Math.random() * 2 - 1) * myScore * 0.10);
    completeMatch(myScore, botScore);
  }
}

async function _submitScoreToServer(arrows) {
  const ms = STATE.matchState;
  if (!ms?.id || ms.isBot) return;
  const payload = {
    arrows: arrows.map((value, arrow_index) => ({ arrow_index, value }))
  };
  try {
    await api('POST', `/api/matches/${ms.id}/score`, payload);
  } catch (e) {
    console.warn('Score submit failed (will not retry):', e.message);
  }
}

function resolveSet() {
  const ms = STATE.matchState;
  const myTotal  = arrowValues.filter(v => v !== null).reduce((a, b) => a + b, 0);
  const oppTotal = Math.max(0, Math.min(30, myTotal + Math.floor((Math.random() * 2 - 1) * 3)));
  let myPts = 0, oppPts = 0;
  if (myTotal > oppTotal) myPts = 2;
  else if (oppTotal > myTotal) oppPts = 2;
  else { myPts = 1; oppPts = 1; }

  ms.setMyScore  += myPts;
  ms.setOppScore += oppPts;
  ms.currentSet++;
  refreshSetScore();

  if (ms.setMyScore >= 6 || ms.setOppScore >= 6) {
    completeMatch(ms.setMyScore, ms.setOppScore);
  } else {
    arrowValues = new Array(3).fill(null);
    ms.setArrowValues = [];
    activeArrowIndex = 0;
    buildSetArrowRow();
    refreshSetArrowCells();
    document.getElementById('set-progress').textContent = `Set ${ms.currentSet}`;
    showToast(`Set: You ${myPts}pts · Opp ${oppPts}pts`, 'info');
  }
  saveMatchState();
}

function refreshSetScore() {
  const ms = STATE.matchState;
  document.getElementById('set-my-score').textContent  = ms.setMyScore;
  document.getElementById('set-opp-score').textContent = ms.setOppScore;
  document.getElementById('set-progress').textContent  = `Set ${ms.currentSet}`;
}

function completeMatch(myScore, oppScore) {
  const ms = STATE.matchState;
  ms.complete = true;
  ms.myFinalScore  = myScore;
  ms.oppFinalScore = oppScore;
  saveMatchState();
  saveToHistory(ms);

  let icon, title, result;
  if (myScore > oppScore)       { icon = '🏆'; title = 'You Win!'; }
  else if (oppScore > myScore)  { icon = '😤'; title = 'Better luck next time'; }
  else                           { icon = '🤝'; title = 'Draw!'; }
  result = `Your score: ${myScore} · ${ms.oppName}: ${oppScore}`;

  document.getElementById('complete-icon').textContent  = icon;
  document.getElementById('complete-title').textContent = title;
  document.getElementById('complete-result').textContent = result;
  document.getElementById('match-complete').classList.remove('hidden');

  localStorage.removeItem('arrowmatch_match_state');
  if (matchSocket) { matchSocket.close(); matchSocket = null; }
}

function startRematch() {
  if (!STATE.matchState) return;
  const prev = STATE.matchState;
  document.getElementById('match-complete').classList.add('hidden');
  startMatch({
    id: `rematch-${Date.now()}`,
    name: prev.oppName,
    isBot: prev.isBot,
    distance: prev.dist,
    scoring: prev.scoring,
    arrowCount: prev.arrowCount,
    type: 'live',
  });
}

function saveMatchState() {
  if (STATE.matchState && !STATE.matchState.complete) {
    localStorage.setItem('arrowmatch_match_state', JSON.stringify(STATE.matchState));
  }
}

// ==================== HISTORY ====================

async function saveToHistory(ms) {
  const entry = {
    id: `h-${Date.now()}`,
    oppName: ms.oppName,
    dist: ms.dist,
    scoring: ms.scoring,
    myScore: ms.myFinalScore || 0,
    oppScore: ms.oppFinalScore || 0,
    result: (ms.myFinalScore || 0) > (ms.oppFinalScore || 0) ? 'win'
           : (ms.myFinalScore || 0) < (ms.oppFinalScore || 0) ? 'loss' : 'draw',
    date: new Date().toISOString(),
  };
  STATE.history.unshift(entry);
  if (STATE.history.length > 100) STATE.history.pop();
  localStorage.setItem('arrowmatch_history', JSON.stringify(STATE.history));
}

async function refreshHistory() {
  // Try to load from server
  try {
    const data = await api('GET', '/api/history?limit=30');
    if (data) {
      // Merge server history with local format
      STATE.history = data.map(h => ({
        id: h.match_id,
        oppName: h.opponent_name,
        dist: h.distance,
        scoring: h.scoring,
        myScore: h.my_score || 0,
        oppScore: h.opponent_score || 0,
        result: h.result,
        date: h.date,
      }));
      localStorage.setItem('arrowmatch_history', JSON.stringify(STATE.history));
    }
  } catch {}

  renderStats();
  renderAchievements();
  renderHistoryList();
}

function renderStats() {
  const last10 = STATE.history.slice(0, 10);
  const wins   = last10.filter(h => h.result === 'win').length;
  const avgScore = last10.length
    ? Math.round(last10.reduce((a, h) => a + h.myScore, 0) / last10.length) : 0;
  const globalRank = Math.max(1, 1000 - wins * 50);
  document.getElementById('stat-avg').textContent  = avgScore || '—';
  document.getElementById('stat-wins').textContent = wins;
  document.getElementById('stat-rank').textContent = `#${globalRank}`;
}

function renderAchievements() {
  const total = STATE.history.length;
  let streak = 0;
  for (const h of STATE.history) {
    if (h.result === 'win') streak++;
    else break;
  }
  const badges = [
    { icon: '🔥', label: '5 Win Streak',  earned: streak >= 5 },
    { icon: '⚡', label: '10 Win Streak', earned: streak >= 10 },
    { icon: '👑', label: '25 Win Streak', earned: streak >= 25 },
    { icon: '🎯', label: '10 Matches',    earned: total >= 10 },
    { icon: '🏹', label: '50 Matches',    earned: total >= 50 },
    { icon: '🌟', label: '100 Matches',   earned: total >= 100 },
  ];
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

// ==================== CHALLENGE LINK ====================

function handleChallengeLink(code) {
  showToast(`Opening challenge…`, 'info');
  showUI();
  // Try to load challenge from API then join
  api('GET', `/api/challenges/${code}`)
    .then(ch => {
      if (ch) joinChallenge(ch.id);
      else startMatch({ id: code, name: 'Challenger', distance: '30m', scoring: 'total', arrowCount: 18 });
    })
    .catch(() => startMatch({ id: code, name: 'Challenger', distance: '30m', scoring: 'total', arrowCount: 18 }));
}

// ==================== FILTERS ====================

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
    STATE.filters.skill.length === 3 &&
    STATE.filters.gender.length === 2 &&
    STATE.filters.bow.length === 3 &&
    STATE.filters.dist.length === 6 &&
    !STATE.filters.country;
  document.getElementById('filter-badge').textContent = allSelected ? 'All' : 'Active';
}

function selectChip(btn, group) {
  const container = btn.closest(`[id$="${group}-chips"]`) || btn.parentElement;
  container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}

// ==================== COUNTRIES ====================

function loadCountries() {
  const countries = [
    'Afghanistan','Albania','Algeria','Argentina','Armenia','Australia','Austria','Azerbaijan',
    'Bangladesh','Belarus','Belgium','Bolivia','Brazil','Bulgaria','Canada','Chile','China',
    'Colombia','Croatia','Czech Republic','Denmark','Ecuador','Egypt','Estonia','Finland',
    'France','Georgia','Germany','Ghana','Greece','Hungary','India','Indonesia','Iran','Iraq',
    'Ireland','Israel','Italy','Japan','Jordan','Kazakhstan','Kenya','South Korea','Latvia',
    'Lebanon','Lithuania','Luxembourg','Malaysia','Mexico','Morocco','Netherlands',
    'New Zealand','Nigeria','Norway','Pakistan','Peru','Philippines','Poland','Portugal',
    'Romania','Russia','Saudi Arabia','Serbia','Singapore','Slovakia','Slovenia',
    'South Africa','Spain','Sri Lanka','Sweden','Switzerland','Taiwan','Turkey','Uganda',
    'Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan',
    'Venezuela','Vietnam',
  ];
  ['s-country', 'filter-country'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    countries.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      sel.appendChild(opt);
    });
  });
}

// ==================== UTILITIES ====================

function _generateLocalId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `AM-${ts}-${rand}`;
}

function _serverProfileToLocal(p) {
  return {
    name:       p.name,
    gender:     p.gender,
    age:        p.age,
    bowType:    p.bow_type,
    skillLevel: p.skill_level,
    country:    p.country,
  };
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
  } else {
    _fallbackCopy(text);
  }
}

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function getTimeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

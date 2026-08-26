// =============================================
// ARROWMATCH — Auth Screen
// Guest, login, register, password reset, logout.
// Depends on: core/state.js, core/api.js, core/utils.js
// =============================================

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
      STATE.userId = _generateLocalId();
      STATE.user   = { isGuest: true, email: null };
      localStorage.setItem('arrowmatch_userid', STATE.userId);
      localStorage.setItem('arrowmatch_user', JSON.stringify(STATE.user));
    }
    showUI();
    WS.connect();
    EventBus.emit(EVENT_TYPES.APP_SESSION_READY, { userId: STATE.userId });
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

    try {
      const p = await api('GET', '/api/profile');
      if (p) {
        STATE.profile = _serverProfileToLocal(p);
        localStorage.setItem('arrowmatch_profile', JSON.stringify(STATE.profile));
      }
    } catch {}

    showUI();
    WS.connect();
    EventBus.emit(EVENT_TYPES.APP_SESSION_READY, { userId: STATE.userId });
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
    WS.connect();
    EventBus.emit(EVENT_TYPES.APP_SESSION_READY, { userId: STATE.userId });
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

const ENTRY_FORM_IDS = [
  'entry-form-login',
  'entry-form-register',
  'entry-form-forgot',
  'entry-form-reset',
];

function _showEntryForm(formId) {
  ENTRY_FORM_IDS.forEach((id) => {
    document.getElementById(id)?.classList.toggle('hidden', id !== formId);
  });
}

function showForgotPassword() {
  _showEntryForm('entry-form-forgot');
  document.getElementById('forgot-email')?.focus();
}

async function handleRequestPasswordReset() {
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) { showToast('Enter your email', 'error'); return; }
  if (!validateEmail(email)) { showToast('Invalid email', 'error'); return; }

  try {
    const data = await api('POST', '/api/auth/forgot-password', { email }, { skipAuth: true });
    if (!data) {
      showToast('Could not connect. Try again.', 'error');
      return;
    }
    showToast(data.message || 'If an account exists, a reset link has been sent.', 'info');
  } catch (e) {
    showToast(e.message || 'Could not send reset link', 'error');
  }
}

function showResetPasswordForm(token) {
  const tokenInput = document.getElementById('reset-token');
  if (!tokenInput || !token) return;
  tokenInput.value = token;
  _showEntryForm('entry-form-reset');
}

async function handleResetPassword() {
  const token = document.getElementById('reset-token').value;
  const password = document.getElementById('reset-password').value;
  const confirmation = document.getElementById('reset-password-confirm').value;
  if (!token) { showToast('Reset link is missing', 'error'); return; }
  if (password.length < 8) { showToast('Password min 8 characters', 'error'); return; }
  if (password !== confirmation) { showToast('Passwords do not match', 'error'); return; }

  try {
    const data = await api('POST', '/api/auth/reset-password',
      { token, password }, { skipAuth: true });
    if (!data) {
      showToast('Could not connect. Try again.', 'error');
      return;
    }
    document.getElementById('reset-password').value = '';
    document.getElementById('reset-password-confirm').value = '';
    _showEntryForm('entry-form-login');
    window.history.replaceState(window.history.state, '', window.location.pathname);
    showToast(data.message || 'Password reset. You can now sign in.', 'success');
  } catch (e) {
    showToast(e.message || 'Could not reset password', 'error');
  }
}

function handleLogout() {
  _clearSession();
  localStorage.clear();
  location.reload();
}

function toggleRegister() {
  const registerForm = document.getElementById('entry-form-register');
  _showEntryForm(registerForm.classList.contains('hidden')
    ? 'entry-form-register' : 'entry-form-login');
}

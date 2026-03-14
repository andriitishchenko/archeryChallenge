// =============================================
// ARROWMATCH — API Layer
// Central fetch helper, token management.
// Depends on: core/state.js
// =============================================

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Central API helper.
 * Handles auth headers, token refresh on 401, and JSON parsing.
 * Returns null on network error (callers fall back to local state).
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
  STATE.accessToken  = access;
  STATE.refreshToken = refresh;
  localStorage.setItem('arrowmatch_access_token', access);
  if (refresh) localStorage.setItem('arrowmatch_refresh_token', refresh);
}

function _clearSession() {
  STATE.userId      = null;
  STATE.accessToken = null;
  STATE.refreshToken = null;
  STATE.user    = null;
  STATE.profile = null;
  localStorage.removeItem('arrowmatch_access_token');
  localStorage.removeItem('arrowmatch_refresh_token');
  localStorage.removeItem('arrowmatch_userid');
  localStorage.removeItem('arrowmatch_user');
}

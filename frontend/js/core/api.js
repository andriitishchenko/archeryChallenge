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

function _redactForConsole(value) {
  if (Array.isArray(value)) return value.map(_redactForConsole);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const sensitive = /token|password|secret|authorization/i.test(key);
    return [key, sensitive ? '[redacted]' : _redactForConsole(item)];
  }));
}

function _logApiRequest(method, path, body, headers, retry = false) {
  console.info('[API →] request', {
    method,
    url: `${API_BASE}${path}`,
    retry,
    headers: _redactForConsole(headers),
    body: _redactForConsole(body),
  });
}

/**
 * Central API helper.
 * Handles auth headers, token refresh on 401, and JSON parsing.
 * Returns null on network error (callers fall back to local state).
 */
async function api(method, path, body = null, { skipAuth = false } = {}) {
  const hasBody = body !== null && body !== undefined;
  const headers = {};
  if (!skipAuth && STATE.accessToken) {
    headers['Authorization'] = `Bearer ${STATE.accessToken}`;
  }
  if (hasBody) headers['Content-Type'] = 'application/json';

  // Build fetch options — never send a body on GET/HEAD/DELETE
  const bodyless = ['GET', 'HEAD', 'DELETE'].includes(method.toUpperCase());
  const fetchOpts = (overrideHeaders) => ({
    method,
    headers: overrideHeaders || headers,
    body: (!bodyless && hasBody) ? JSON.stringify(body) : undefined,
  });
  const sendRequest = (requestHeaders, retry = false) => {
    _logApiRequest(method, path, body, requestHeaders, retry);
    return fetch(`${API_BASE}${path}`, fetchOpts(requestHeaders));
  };

  let resp;
  try {
    resp = await sendRequest(headers);
  } catch (err) {
    console.warn('[API ×] request failed', { method, path, error: err.message });
    return null;
  }

  // 401 → attempt token refresh once
  if (resp.status === 401 && STATE.refreshToken && !skipAuth) {
    const refreshed = await _tryRefresh();
    if (refreshed) {
      const retryHeaders = { ...headers, 'Authorization': `Bearer ${STATE.accessToken}` };
      resp = await sendRequest(retryHeaders, true);
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
  WS.disconnect();
  STATE.userId       = null;
  STATE.accessToken  = null;
  STATE.refreshToken = null;
  STATE.user         = null;
  STATE.profile      = null;
  localStorage.removeItem('arrowmatch_access_token');
  localStorage.removeItem('arrowmatch_refresh_token');
  localStorage.removeItem('arrowmatch_userid');
  localStorage.removeItem('arrowmatch_user');
}

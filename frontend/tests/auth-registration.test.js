const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const authSource = fs.readFileSync(path.join(__dirname, '../js/screens/auth.js'), 'utf8');

function loadAuthScreen({ accessToken = null, userId = 'local-only' } = {}) {
  const fields = {
    'reg-email': { value: 'new@example.com' },
    'reg-password': { value: 'strong-pass-1' },
    'acc-email': { value: 'new@example.com' },
    'acc-password': { value: 'strong-pass-1' },
  };
  const calls = [];
  const stored = new Map();
  const context = {
    STATE: { userId, accessToken, refreshToken: null },
    document: { getElementById: (id) => fields[id] || null },
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    api: async (...args) => {
      calls.push(args);
      return {
        user_id: 'server-user',
        is_guest: false,
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      };
    },
    validateEmail: () => true,
    _storeTokens: () => {},
    showUI: () => {},
    showScene: () => {},
    showToast: () => {},
    updateSettingsAccountSection: () => {},
    WS: { connect: () => {} },
    EventBus: { emit: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(authSource, context);
  return { context, calls, stored };
}

test('guest registration sends the matching user ID with authenticated API defaults', async () => {
  const { context, calls } = loadAuthScreen({ accessToken: 'guest-access', userId: 'guest-1' });

  await context.handleRegister();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'POST');
  assert.equal(calls[0][1], '/api/auth/register');
  assert.equal(calls[0][2].existing_user_id, 'guest-1');
  assert.equal(calls[0][3], undefined);
});

test('account creation without a server guest omits the local-only ID and stores server identity', async () => {
  const { context, calls, stored } = loadAuthScreen({ userId: 'local-only' });

  await context.handleCreateAccount();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].existing_user_id, null);
  assert.equal(calls[0][3], undefined);
  assert.equal(context.STATE.userId, 'server-user');
  assert.equal(stored.get('arrowmatch_userid'), 'server-user');
});

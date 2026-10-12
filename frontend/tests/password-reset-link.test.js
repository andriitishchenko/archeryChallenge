const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appInitSource = fs.readFileSync(path.join(__dirname, '../js/app-init.js'), 'utf8');

async function restoreFromUrl({ search = '', hash = '' } = {}) {
  const resetTokens = [];
  const replacements = [];
  const sceneElements = new Map(['scene-entry', 'back-btn', 'topnav', 'bottomnav'].map((id) => [id, {
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  }]));
  const context = {
    STATE: { activeMatches: {} },
    URLSearchParams,
    document: {
      addEventListener: () => {},
      querySelectorAll: () => [],
      getElementById: (id) => sceneElements.get(id) || null,
    },
    localStorage: { getItem: () => null },
    window: {
      location: { pathname: '/', search, hash },
      history: {
        state: { marker: true },
        replaceState: (...args) => replacements.push(args),
      },
    },
    showResetPasswordForm: (token) => resetTokens.push(token),
    updateNavTitle: () => {},
    EVENT_TYPES: { APP_SCENE_CHANGE: 'scene-change' },
    EventBus: { emit: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(appInitSource, context);
  await context.restoreSession();
  return { currentScene: context.STATE.currentScene, resetTokens, replacements };
}

test('reset token from the URL fragment opens the reset form and is removed from the address', async () => {
  const result = await restoreFromUrl({ search: '?c=challenge-1', hash: '#reset_token=one-time-secret' });

  assert.deepEqual(result.resetTokens, ['one-time-secret']);
  assert.equal(result.currentScene, 'entry');
  assert.equal(result.replacements.length, 1);
  assert.equal(result.replacements[0][0].marker, true);
  assert.equal(result.replacements[0][2], '/?c=challenge-1');
});

test('reset tokens in the query string are not forwarded to the reset form', async () => {
  const result = await restoreFromUrl({ search: '?reset_token=legacy-secret' });

  assert.deepEqual(result.resetTokens, []);
  assert.equal(result.currentScene, 'entry');
  assert.deepEqual(result.replacements, []);
});

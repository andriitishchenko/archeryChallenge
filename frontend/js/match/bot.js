// =============================================
// ARROWMATCH — Bot & Mock Data
// Offline opponent generation and mock challenges.
// All helpers are module-level (no _ prefix) since
// set-mode.js and total-mode.js call them directly.
// Depends on: core/state.js
// =============================================

const BOT_SKILL = {
  'Beginner': { mean: 5,   dev: 2   },
  'Skilled':  { mean: 8,   dev: 1   },
  'Master':   { mean: 9.5, dev: 0.5 },
};

function genBotArrow(skill) {
  const { mean, dev } = BOT_SKILL[skill] || BOT_SKILL['Skilled'];
  const v = Math.round(mean + (Math.random() * 2 - 1) * dev * 2);
  return Math.max(0, Math.min(10, v));
}

function genBotArrows(skill, count = 3) {
  return Array.from({ length: count }, () => genBotArrow(skill));
}

function genBotTotal(myScore, skill) {
  const { mean, dev } = BOT_SKILL[skill] || BOT_SKILL['Skilled'];
  const ratio = mean / 10;
  const base  = Math.round(myScore * ratio + (Math.random() * 2 - 1) * 5);
  return Math.max(0, base);
}

// ── Shadow bot ───────────────────────────────────────────────────────────────

function _botClamp(value, min = 0, max = 10) {
  return Math.max(min, Math.min(max, value));
}

function _botRandomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function _botAveragePerArrow() {
  const scores = STATE.history
    .filter(h => h.scoring !== 'sets' && Number.isFinite(Number(h.myScore)) && Number(h.myScore) > 0)
    .map(h => Number(h.myScore) / (Number(h.arrowCount) || 18));
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function _botCurrentMatchAverage(ms) {
  const scores = Array.isArray(ms?._botPlayerRoundAverages)
    ? ms._botPlayerRoundAverages.filter(Number.isFinite)
    : [];
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function _botShadowMean(ms) {
  const profile = BOT_SKILL[ms.oppSkill || 'Skilled'] || BOT_SKILL['Skilled'];
  const historicalAverage = _botAveragePerArrow();
  const currentMatchAverage = _botCurrentMatchAverage(ms);
  const playerAverage = currentMatchAverage ?? historicalAverage;
  // Current-match performance is the strongest reference. Historical results
  // still help during the first round, while bot skill keeps new matches varied.
  const mean = playerAverage === null
    ? profile.mean
    : playerAverage * (currentMatchAverage === null ? 0.7 : 0.9) + profile.mean * (currentMatchAverage === null ? 0.3 : 0.1);
  return _botClamp(mean);
}

function _botShadowRound(ms, round, count) {
  if (
    !ms._botShadow
    || ms._botShadow.round !== round
    || ms._botShadow.count !== count
  ) {
    ms._botShadow = {
      round,
      count,
      mean: _botShadowMean(ms),
      arrows: new Array(count).fill(null),
      playerArrows: new Array(count).fill(null),
    };
  }
  return ms._botShadow;
}

function _botShadowRoundName(ms) {
  if (ms._tiebreakRequired) return 'total-tiebreak';
  if (ms.scoring === 'sets') {
    return ms._tiebreak ? 'set-tiebreak' : `set-${ms.currentSet || 1}`;
  }
  return 'total';
}

function botShadowShoot(ms, index, userValue, count) {
  if (!ms?.isBot) return [];
  const state = _botShadowRound(ms, _botShadowRoundName(ms), count);
  if (Number.isFinite(userValue)) state.playerArrows[index] = userValue;
  if (state.arrows[index] == null) {
    const entered = state.playerArrows.filter(value => Number.isFinite(value));
    const enteredMean = entered.length
      ? entered.reduce((sum, value) => sum + value, 0) / entered.length
      : null;
    // Mirror the live series immediately. This is deliberately driven by the
    // current input, not only by old history, so a run of 10s is visible as a
    // run near 10s on the opponent side before submission.
    const reference = enteredMean === null
      ? state.mean
      : enteredMean * 0.8 + state.mean * 0.2;
    const jitter = (Math.random() * 2 - 1) * 0.8;
    state.arrows[index] = Math.round(_botClamp(
      reference + jitter,
    ));
  }
  return [...state.arrows];
}

function botShadowDelete(ms, index, count) {
  if (!ms?.isBot) return [];
  const state = _botShadowRound(ms, _botShadowRoundName(ms), count);
  state.playerArrows[index] = null;
  state.arrows[index] = null;
  return [...state.arrows];
}

function _botMoveToTarget(arrows, target) {
  let difference = target - arrows.reduce((sum, value) => sum + value, 0);
  for (let index = arrows.length - 1; index >= 0 && difference !== 0; index--) {
    const room = difference > 0 ? 10 - arrows[index] : arrows[index];
    const step = difference > 0
      ? Math.min(difference, room)
      : -Math.min(-difference, room);
    arrows[index] += step;
    difference -= step;
  }
  return arrows;
}

function botShadowFinalize(ms, userTotal, count) {
  if (!ms?.isBot) return [];
  const state = _botShadowRound(ms, _botShadowRoundName(ms), count);
  const arrows = state.arrows.map(value => value == null
    ? Math.round(_botClamp(state.mean + (Math.random() * 2 - 1) * 0.8))
    : value);
  const maximum = count * 10;
  const playerMean = Number.isFinite(userTotal) && count > 0 ? userTotal / count : state.mean;
  const baseline = playerMean * count;
  let target = Math.round(baseline + (Math.random() * 2 - 1) * Math.max(1, count * 0.12));

  // Roughly one quarter of rounds deliberately give the bot a narrow edge;
  // another quarter gives the player an edge. The remaining rounds follow
  // the player's current performance with a small natural variation.
  const outcome = Math.random();
  const margin = _botRandomInt(1, Math.max(1, Math.round(count * 0.2)));
  if (outcome < 0.25) target = userTotal + margin;
  else if (outcome < 0.50) target = userTotal - margin;
  target = Math.round(_botClamp(target, 0, maximum));

  state.arrows = _botMoveToTarget(arrows, target);
  if (Number.isFinite(playerMean)) {
    if (!Array.isArray(ms._botPlayerRoundAverages)) ms._botPlayerRoundAverages = [];
    ms._botPlayerRoundAverages.push(playerMean);
    if (ms._botPlayerRoundAverages.length > 20) ms._botPlayerRoundAverages.shift();
  }
  return [...state.arrows];
}

function generateBotOpponent() {
  const names = ['BotArcher_Theta', 'AutoNock_7', 'RoboRelease', 'CyberBow_X'];
  return {
    id:         `bot-${Date.now()}`,
    name:       names[Math.floor(Math.random() * names.length)],
    isBot:      true,
    distance:   '30m',
    scoring:    'total',
    arrowCount: STATE.arrowCount,
    type:       'live',
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
    id:                  `mock-${i}`,
    creator_name:        names[i % names.length],
    creator_gender:      i % 2 === 0 ? 'Male' : 'Female',
    creator_age:         ages[i % 3],
    creator_bow_type:    bows[i % 3],
    creator_skill_level: skills[i % 3],
    distance:            dists[i % 4],
    invite_message:      msgs[i % msgs.length],
    type:                i % 2 === 0 ? 'live' : 'async',
    created_at:          new Date(Date.now() - i * 180000).toISOString(),
  }));
}

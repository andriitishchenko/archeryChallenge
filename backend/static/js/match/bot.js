// =============================================
// ARROWMATCH — Bot & Mock Data
// Offline opponent generation and mock challenges.
// Depends on: core/state.js
// =============================================

const _BOT_SKILL = {
  'Beginner':     { mean: 5,   dev: 2   },
  'Intermediate': { mean: 7,   dev: 1.5 },
  'Skilled':      { mean: 8,   dev: 1   },
  'Advanced':     { mean: 9,   dev: 0.8 },
  'Expert':       { mean: 9.5, dev: 0.5 },
};

function _genBotArrow(skill) {
  const { mean, dev } = _BOT_SKILL[skill] || _BOT_SKILL['Skilled'];
  const v = Math.round(mean + (Math.random() * 2 - 1) * dev * 2);
  return Math.max(0, Math.min(10, v));
}

function _genBotArrows(skill, count = 3) {
  return Array.from({ length: count }, () => _genBotArrow(skill));
}

function _genBotTotal(myScore, skill) {
  const { mean, dev } = _BOT_SKILL[skill] || _BOT_SKILL['Skilled'];
  const ratio = mean / 10;
  const base  = Math.round(myScore * ratio + (Math.random() * 2 - 1) * 5);
  return Math.max(0, base);
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

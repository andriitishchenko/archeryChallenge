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

const BOT_RESULT_COEFFICIENT = {
  Beginner: -0.35,
  Skilled:   0.25,
  Master:    0.55,
};

// The shadow bot should feel like a separate player, not a copy of the live
// input. Keep the spread skill-sensitive, but wide enough that every skill
// level can produce both noticeably better and worse arrows than the player.
const BOT_RESULT_SPREAD = {
  Beginner: 2.6,
  Skilled:   2.2,
  Master:    1.6,
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

function _botResultCoefficient(ms) {
  return BOT_RESULT_COEFFICIENT[ms?.oppSkill || 'Skilled']
    ?? BOT_RESULT_COEFFICIENT.Skilled;
}

function _botResultSpread(ms) {
  return BOT_RESULT_SPREAD[ms?.oppSkill || 'Skilled']
    ?? BOT_RESULT_SPREAD.Skilled;
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
  const state = ms._botShadow;
  // Older localStorage snapshots may predate playerArrows. Rebuild that
  // transient array from the user's saved input instead of crashing on reload.
  if (!Array.isArray(state.playerArrows) || state.playerArrows.length !== count) {
    const savedValues = ms.scoring === 'sets' ? ms.setArrowValues : ms.arrowValues;
    state.playerArrows = new Array(count).fill(null);
    if (Array.isArray(savedValues)) {
      savedValues.slice(0, count).forEach((value, index) => {
        if (Number.isFinite(value)) state.playerArrows[index] = value;
      });
    }
  }
  return state;
}

function _botShadowRoundName(ms) {
  if (ms._tiebreakRequired) return 'total-tiebreak';
  if (ms.scoring === 'sets') {
    return ms._tiebreak ? 'set-tiebreak' : `set-${ms.currentSet || 1}`;
  }
  return 'total';
}

function _botLastPlayerValue(state) {
  const values = Array.isArray(state.playerArrows) ? state.playerArrows : [];
  for (let index = values.length - 1; index >= 0; index--) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
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
    // Use the live input as one reference, but keep the bot's own form in the
    // mix. A wider signed spread makes the preview capable of landing above
    // or below the player's arrow instead of mirroring it almost exactly.
    const lastPlayerValue = _botLastPlayerValue(state);
    const coefficient = _botResultCoefficient(ms);
    const reference = lastPlayerValue === null
      ? (enteredMean === null ? state.mean : enteredMean) + coefficient
      : lastPlayerValue * 0.65 + state.mean * 0.35 + coefficient;
    const jitter = (Math.random() * 2 - 1) * _botResultSpread(ms);
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

function botShadowFinalize(ms, userTotal, count) {
  if (!ms?.isBot) return [];
  const state = _botShadowRound(ms, _botShadowRoundName(ms), count);
  const arrows = state.arrows.map(value => value == null
    ? Math.round(_botClamp(
      state.mean
        + _botResultCoefficient(ms)
        + (Math.random() * 2 - 1) * _botResultSpread(ms),
    ))
    : value);
  const playerMean = Number.isFinite(userTotal) && count > 0 ? userTotal / count : state.mean;
  // Finalization must score the same arrows that were shown during the round.
  // Only missing values (for example after restoring an old local snapshot)
  // are generated here; never alter an already-shot bot arrow to hit a target.
  state.arrows = arrows;
  ms._botFinalArrows = [...arrows];
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

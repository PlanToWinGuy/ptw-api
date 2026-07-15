// LifeScore ("Projected Healthspan") -- a motivational score, not a medical prediction.
// Matches the founder's LifeScore & Gamification Engine spec (Section 2.X): a one-time
// onboarding baseline (age-based, plus an "Initial Bonus" carved out of the Fitness
// pillar's own cap for self-assessed current habits), and a live total built from real
// per-pillar XP via a proper leveling system (Base Task XP x Task Difficulty x Goal
// Difficulty -> XP -> levels -> +0.1yr/level, capped per pillar, with a Maintenance
// Phase once a pillar tops out).

// Section 2.0: real, publicly documented country-by-country life-expectancy tables exist
// (WHO/UN) but hardcoding dozens of country figures from memory risks presenting guessed
// numbers as authoritative demographic data -- worse than not having them. Age anchors to
// a single, widely-cited global average instead; a real WHO/UN dataset is a clean future
// upgrade slot, not something to fake here.
const GLOBAL_AVG_LIFE_EXPECTANCY = 73;

// Section 2.3.1's cap table, corrected against the full MSD v2.0 (the earlier excerpt
// this was originally built from was missing Finances entirely and had Anti-Goals wrong
// at +10 instead of +7). Finances XP was already being tracked in pillarXpByKey the whole
// time (per-pillar XP aggregation below is generic) -- it just never counted toward the
// Healthspan number because there was no cap entry for it to level against.
export const PILLAR_CAPS = { antiGoals: 7, fitness: 8, diet: 7, relations: 6, work: 5, personal: 4, finances: 3 };

// Section 4.0: XP needed per level, and Healthspan years granted per level. At 100 XP/level,
// topping out a pillar's cap (e.g. Fitness's 8yr / 0.1yr-per-level = 80 levels) takes 8,000
// real XP -- a multi-month project of consistent logging, not a same-day unlock, matching
// the spec's framing of "short-term feedback loop, long-term cumulative payoff."
const XP_PER_LEVEL = 100;
const YEARS_PER_LEVEL = 0.1;

// Section 3.0: Base Task XP by what the task/log actually is, matching the spec's own
// worked example ("Workout = 50 XP") instead of one flat rate for every action. Pillar-
// relevant, science-backed action types are weighted higher, same idea as the spec's
// restated 1.5x pillar-relevance note.
export const BASE_TASK_XP = {
  workout: 50, meal: 35, weight: 15, transaction: 20, fixed_bill: 15, asset: 15,
  budget_goal: 10, savings_goal: 10, contact: 25, connection: 30, social_event: 30,
  focus_area: 25, personal_log: 20, journal_entry: 20, work_session: 35, default: 25,
};

// Task Difficulty Multiplier: no per-task difficulty rating exists on the schema (and
// inventing one would be fake data), so this uses the task's own real
// estimated_duration_minutes as an honest proxy -- a 60-minute task is objectively more
// effortful than a 15-minute one, same spirit as the spec's Easy=1.0x/Hard=2.0x.
export function taskDifficultyMultiplier(durationMinutes) {
  const min = Number(durationMinutes) || 20;
  if (min <= 20) return 1.0;
  if (min <= 45) return 1.3;
  return 1.6;
}

// Goal Difficulty Multiplier: goals.difficulty is a real 1-5 rating already captured at
// generation time (INSERT INTO goals ... difficulty). Maps linearly onto the spec's own
// worked example -- an "Advanced" (5/5) goal grants 2.0x, the default 3/5 grants 1.5x.
export function goalDifficultyMultiplier(goalDifficulty) {
  const d = Number(goalDifficulty) || 3;
  return 1 + (Math.max(1, Math.min(5, d)) - 1) * 0.25;
}

// Section 3.0: XP Earned = Base Task XP x Task Difficulty Multiplier x Goal Difficulty
// Multiplier. All three inputs are real fields already on the task/goal row -- no schema
// change needed. taskType keys into BASE_TASK_XP (a task's tool_hint, or a metric log's
// own log_type for ad-hoc entries with no linked task).
export function calculateTaskXp({ taskType, durationMinutes, goalDifficulty }) {
  const base = BASE_TASK_XP[taskType] || BASE_TASK_XP.default;
  const taskMult = taskDifficultyMultiplier(durationMinutes);
  const goalMult = goalDifficultyMultiplier(goalDifficulty);
  return Math.round(base * taskMult * goalMult);
}

function bmiCategory(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  const bmi = weightKg / (m * m);
  if (bmi < 18.5) return 'underweight';
  if (bmi < 25) return 'normal';
  if (bmi < 30) return 'overweight';
  return 'obese';
}

function ageFromDob(dob) {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob).getTime();
  return ms > 0 ? Math.floor(ms / (365.25 * 86400000)) : null;
}

// Section 2.0: onboarding baseline = a real age-anchored demographic starting point, plus
// an "Initial Bonus" -- partial credit toward the Fitness pillar's OWN cap for a
// self-reported current fitness level, rather than a disconnected flat adjustment. The
// remaining potential (e.g. someone who self-reports "Advanced" but hasn't logged
// anything yet) is earned the same way as everyone else: through real ongoing Fitness XP
// via the leveling system below, which functions as the spec's "Consistency Goal" without
// needing a bespoke one-off goal type that would just disappear after a few weeks.
const FITNESS_INITIAL_BONUS_FRACTION = { advanced: 0.4, intermediate: 0.2, beginner: 0 };
export function calculateBaseline({ dob, height, weight, fitness_level, sleep_quality, stress_level }) {
  const age = ageFromDob(dob);
  let baseline = GLOBAL_AVG_LIFE_EXPECTANCY;

  const bmi = bmiCategory(Number(height), Number(weight));
  const bmiAdjust = { underweight: -1, normal: 2, overweight: -2, obese: -4 }[bmi] || 0;
  const sleepAdjust = { Poor: -2, Average: 0, Good: 2 }[sleep_quality] || 0;
  const stressAdjust = { High: -3, Medium: 0, Low: 2 }[stress_level] || 0;

  const fitnessKey = String(fitness_level || '').toLowerCase();
  const initialBonusYears = Math.round(PILLAR_CAPS.fitness * (FITNESS_INITIAL_BONUS_FRACTION[fitnessKey] || 0) * 10) / 10;

  // A slight further-along-in-life discount keeps very old ages from implausibly
  // outrunning the global-average anchor -- small (0.02yr per year past the average),
  // not a full actuarial curve, since a real one needs a verified table this file
  // deliberately doesn't fabricate.
  const ageAdjust = age && age > GLOBAL_AVG_LIFE_EXPECTANCY ? -Math.round((age - GLOBAL_AVG_LIFE_EXPECTANCY) * 0.02 * 10) / 10 : 0;

  baseline = baseline + bmiAdjust + sleepAdjust + stressAdjust + initialBonusYears + ageAdjust;
  return {
    baseline: Math.max(50, Math.min(99, Math.round(baseline * 10) / 10)),
    initialBonusYears,
    remainingFitnessBonusYears: Math.round((PILLAR_CAPS.fitness - initialBonusYears) * 10) / 10,
  };
}

// Section 4.0/5.0/6.0: real per-pillar XP -> levels -> years, capped, with a Maintenance
// Phase flag once a pillar hits its own cap. Once capped, XP still counts toward
// total_lifetime_xp (tracked separately as users.xp, uncapped, unaffected by this) --
// motivation for that pillar shifts to habit streak instead of a still-climbing number.
export function calculateLifeScore(baseline, pillarXpByKey) {
  let total = Number(baseline) || GLOBAL_AVG_LIFE_EXPECTANCY;
  const breakdown = [];
  for (const [key, cap] of Object.entries(PILLAR_CAPS)) {
    const xp = pillarXpByKey[key] || 0;
    const level = Math.floor(xp / XP_PER_LEVEL);
    const yearsUncapped = Math.round(level * YEARS_PER_LEVEL * 10) / 10;
    const years = Math.min(cap, yearsUncapped);
    const isMaintenance = yearsUncapped >= cap;
    total += years;
    breakdown.push({
      pillar: key,
      xp,
      level,
      years_contributed: years,
      cap,
      is_maintenance: isMaintenance,
      xp_to_next_level: XP_PER_LEVEL - (xp % XP_PER_LEVEL),
    });
  }
  return { lifeScore: Math.min(99, Math.round(total * 10) / 10), breakdown };
}

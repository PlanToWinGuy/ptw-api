// LifeScore ("Projected Healthspan") -- a motivational score, not a medical prediction.
// Two layers: a one-time onboarding baseline, and a live total that adds real,
// capped, per-pillar contribution on top of it. Exact weights here are a first,
// defensible pass -- expect tuning once the founder specs out the exact formula.

const BMI_ADJUST = { underweight: -1, normal: 2, overweight: -2, obese: -4 };
const FITNESS_ADJUST = { beginner: 0, intermediate: 1, advanced: 3 };
const SLEEP_ADJUST = { Poor: -2, Average: 0, Good: 2 };
const STRESS_ADJUST = { High: -3, Medium: 0, Low: 2 };

function bmiCategory(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  const bmi = weightKg / (m * m);
  if (bmi < 18.5) return 'underweight';
  if (bmi < 25) return 'normal';
  if (bmi < 30) return 'overweight';
  return 'obese';
}

export function calculateBaseline({ height, weight, fitness_level, sleep_quality, stress_level }) {
  let score = 78;
  const bmi = bmiCategory(Number(height), Number(weight));
  if (bmi) score += BMI_ADJUST[bmi];
  // fitness_level arrives capitalized from the UI ('Beginner'/'Intermediate'/'Advanced')
  // but FITNESS_ADJUST's keys are lowercase -- without normalizing, this always missed
  // and silently contributed 0 regardless of level.
  if (fitness_level) score += FITNESS_ADJUST[String(fitness_level).toLowerCase()] ?? 0;
  if (sleep_quality) score += SLEEP_ADJUST[sleep_quality] ?? 0;
  if (stress_level) score += STRESS_ADJUST[stress_level] ?? 0;
  return Math.max(50, Math.min(99, score));
}

// Anti-Goals' +7yr cap is listed for completeness but stays at 0 contribution
// until that feature actually exists.
export const PILLAR_CAPS = { fitness: 8, diet: 7, finances: 3, relations: 6, personal: 4, work: 5, antiGoals: 7 };
export const MASTERY_XP_THRESHOLD = 5000; // XP in a pillar considered "fully earning" its cap -- tunable

export function calculateLifeScore(baseline, pillarXpByKey) {
  let total = Number(baseline) || 78;
  const breakdown = [];
  for (const [key, cap] of Object.entries(PILLAR_CAPS)) {
    if (key === 'antiGoals') continue; // not built yet
    const xp = pillarXpByKey[key] || 0;
    const years = Math.round(cap * Math.min(1, xp / MASTERY_XP_THRESHOLD) * 10) / 10;
    total += years;
    breakdown.push({ pillar: key, years_contributed: years, cap });
  }
  return { lifeScore: Math.min(99, Math.round(total * 10) / 10), breakdown };
}

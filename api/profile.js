import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { calculateBaseline } from '../lib/lifescore.js';

// Handles /api/profile-creation and /api/valueprint via vercel.json rewrites
// (?action=profile-creation|valueprint) -- both are "update my user record" mutations.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const action = req.query.action;

  if (action === 'profile-creation') {
    const { username, dob, gender, height, weight, fitness_level, diet, sleep_quality, stress_level } = req.body || {};
    const { baseline, initialBonusYears, remainingFitnessBonusYears } = calculateBaseline({ dob, height, weight, fitness_level, sleep_quality, stress_level });
    await sql`
      UPDATE users SET
        username = COALESCE(${username}, username),
        dob = ${dob || null},
        gender = ${gender || null},
        height = ${height || null},
        weight = ${weight || null},
        fitness_level = ${fitness_level || null},
        diet = ${diet || null},
        sleep_quality = ${sleep_quality || null},
        stress_level = ${stress_level || null},
        life_score = ${baseline}
      WHERE id = ${user.id}
    `;
    return res.status(200).json({ message: 'Profile saved', lifescore_baseline: baseline, initial_bonus_years: initialBonusYears, remaining_fitness_bonus_years: remainingFitnessBonusYears });
  }

  if (action === 'valueprint') {
    const { valueprint_data } = req.body || {};
    if (!valueprint_data) return res.status(422).json({ message: 'valueprint_data is required' });
    const recommended = valueprint_data.recommended_pillar || null;
    await sql`
      UPDATE users SET
        valueprint_data = ${JSON.stringify(valueprint_data)}::jsonb,
        recommended_pillar = COALESCE(${recommended}, recommended_pillar)
      WHERE id = ${user.id}
    `;
    return res.status(200).json({ message: 'Valueprint saved', recommended_pillar: recommended });
  }

  res.status(404).json({ message: 'Unknown profile action' });
}

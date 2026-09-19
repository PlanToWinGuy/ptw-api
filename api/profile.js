import { sql, pillarIdFromName, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest, hashPassword, verifyPassword } from '../lib/auth.js';
import { calculateBaseline } from '../lib/lifescore.js';
import { createBookendRoutines } from '../lib/routines.js';
import { getPillarState } from '../lib/pillarState.js';

// Handles /api/profile-creation and /api/valueprint via vercel.json rewrites
// (?action=profile-creation|valueprint) -- both are "update my user record" mutations.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const action = req.query.action;

  if (action === 'profile-creation') {
    const { username, dob, gender, height, weight, fitness_level, diet, sleep_quality, stress_level, wake_time, wind_down_time } = req.body || {};
    if (username) {
      const existing = await sql`SELECT id FROM users WHERE username = ${username} AND id != ${user.id}`;
      if (existing.length) return res.status(422).json({ message: 'Validation failed', errors: { username: ['That username is already taken.'] } });
    }
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
        wake_time = ${wake_time || null},
        wind_down_time = ${wind_down_time || null},
        life_score = ${baseline}
      WHERE id = ${user.id}
    `;
    // Mandatory Morning/Wind-Down bookend routines, built around the times just given --
    // real editable routines from the moment onboarding finishes, not just stored data
    // with nothing acting on it.
    if (wake_time || wind_down_time) {
      await createBookendRoutines(user.id, wake_time || null, wind_down_time || null);
    }
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

    // Redesign item #1: Personal ALWAYS activates as part of Valueprint completion,
    // unconditionally -- not gated by canActivateNextPillar (Personal is exempt since
    // it's the pillar Valueprint's own data belongs to) and not dependent on which pillar
    // the gap-analysis happens to recommend. This is the real server-side gate (mirrors
    // the pattern in api/pillar/[pillar].js's ?action=activate) -- the frontend's old
    // "auto-activate vp.recommended_pillar, but only if can_activate_next_pillar" call is
    // being removed as part of this same change; the recommended pillar (if different
    // from Personal) is no longer auto-activated at all -- it just becomes one of the
    // up-to-2 additional free picks a user can make in Phase 1 (see lib/pillarState.js
    // canActivateNextPillar, which now allows pillars #2 and #3 unconditionally).
    // ON CONFLICT ... DO UPDATE reactivates Personal with full history if it was
    // previously soft-deactivated via a Phase 1 swap; a no-op if it's already active.
    const personal_id = pillarIdFromName('Personal');
    const beforeState = await getPillarState(user);
    const personalAlreadyActive = beforeState.unlockedPillars.includes('personal');
    await sql`
      INSERT INTO user_pillars (user_id, pillar_id) VALUES (${user.id}, ${personal_id})
      ON CONFLICT (user_id, pillar_id) DO UPDATE SET active = true WHERE user_pillars.active = false
    `;
    // Only starts the phase clock if this is a genuinely new activation -- retaking the
    // Valueprint with Personal already active shouldn't reset an in-progress Phase 1/2
    // consistency window.
    if (!personalAlreadyActive) {
      await sql`UPDATE users SET phase_start_date = now() WHERE id = ${user.id}`;
    }
    const rows = await sql`SELECT pillar_id FROM user_pillars WHERE user_id = ${user.id} AND active = true ORDER BY activated_at ASC`;
    const unlocked_pillars = rows.map(r => (PILLARS[r.pillar_id] || '').toLowerCase());

    return res.status(200).json({ message: 'Valueprint saved', recommended_pillar: recommended, unlocked_pillars });
  }

  if (action === 'change-password') {
    const { current_password, new_password } = req.body || {};
    // A Google-only account has no password_hash to verify against -- it can't "change" a
    // password it never had, so guide it to keep using Google rather than fail cryptically.
    if (!user.password_hash) {
      return res.status(422).json({ message: 'This account signs in with Google, so it has no password to change.' });
    }
    if (!new_password || new_password.length < 8) {
      return res.status(422).json({ message: 'Validation failed', errors: { new_password: ['New password must be at least 8 characters.'] } });
    }
    if (!current_password || !(await verifyPassword(current_password, user.password_hash))) {
      return res.status(422).json({ message: 'Validation failed', errors: { current_password: ['Your current password is incorrect.'] } });
    }
    const password_hash = await hashPassword(new_password);
    await sql`UPDATE users SET password_hash = ${password_hash} WHERE id = ${user.id}`;
    return res.status(200).json({ message: 'Password updated successfully.' });
  }

  res.status(404).json({ message: 'Unknown profile action' });
}

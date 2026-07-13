import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

const PHASE_NAMES = { 1: 'Phase 1: Come Up', 2: 'Phase 2: Traction', 3: 'Phase 3: Confidence', 4: 'Phase 4: Flow State' };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const [{ standard_pct }] = await sql`
    SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS standard_pct
    FROM tasks WHERE user_id = ${user.id} AND created_at > now() - interval '21 days'
  `;
  const [{ fast_pct }] = await sql`
    SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS fast_pct
    FROM tasks WHERE user_id = ${user.id} AND created_at > now() - interval '7 days'
  `;
  const breakdownRows = await sql`
    SELECT p.name AS pillar, COUNT(*) FILTER (WHERE t.status = 'Completed') AS completed
    FROM tasks t JOIN pillars p ON p.id = t.pillar_id
    WHERE t.user_id = ${user.id}
    GROUP BY p.name
  `;

  res.status(200).json({
    data: {
      username: user.username || user.name,
      profilePicUrl: null,
      phase: PHASE_NAMES[user.phase] || PHASE_NAMES[1],
      phaseStartDate: user.phase_start_date,
      phase_progress: {
        standard_path: { description: 'Achieve 80% completion over 3 weeks', target_percent: 80, current_average_percent: Number(standard_pct) },
        fast_track_path: { description: 'Achieve 95% completion in 1 week', target_percent: 95, current_week_percent: Number(fast_pct) },
      },
      lifeScore: Number(user.life_score),
      lifescore_breakdown: breakdownRows,
      xp: user.xp,
      recommended_pillar: user.recommended_pillar,
      subscription_tier: null,
    },
  });
}

import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getAdminFromRequest } from '../lib/auth.js';
import { computeStreakDays } from '../lib/tasks.js';

// GET /api/admin?section=users|coaching -- the founder-only admin panel's "Users
// overview" and "Coaching oversight" sections (bug reports/error log have their own
// endpoints -- api/bug-reports.js, api/error-logs.js -- since those also need POST from
// regular users; this one is admin-only end to end).
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(403).json({ message: 'Forbidden' });

  const section = req.query.section || 'users';

  if (section === 'users') {
    // Small beta (a few dozen users) -- a real list with just enough context to spot who's
    // stuck or inactive, not a full data dump: signup date, active pillars, last real
    // activity (most recent completed/updated task or logged metric), XP, and streak.
    const rows = await sql`
      SELECT
        u.id, u.name, u.email, u.created_at, u.phase, u.xp, u.life_score,
        (SELECT array_agg(p.name ORDER BY p.name) FROM user_pillars up JOIN pillars p ON p.id = up.pillar_id WHERE up.user_id = u.id AND up.active = true) AS active_pillars,
        GREATEST(
          COALESCE((SELECT MAX(updated_at) FROM tasks t WHERE t.user_id = u.id), 'epoch'::timestamptz),
          COALESCE((SELECT MAX(logged_at) FROM metric_logs m WHERE m.user_id = u.id), 'epoch'::timestamptz)
        ) AS last_active_at
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 500
    `;
    const streaks = await Promise.all(rows.map(r => computeStreakDays(sql, { id: r.id }).catch(() => 0)));
    const data = rows.map((r, i) => ({ ...r, streak_days: streaks[i] }));
    return res.status(200).json({ data });
  }

  if (section === 'coaching') {
    // Recent AI Assistant + goal-refinement turns, most recent first -- truncated
    // excerpts written by api/ai/chat.js / api/goals/refine-chat.js (see coach_sessions
    // in schema.sql), enough to spot a quality issue or an errored turn without full
    // transcript surveillance.
    const rows = await sql`
      SELECT cs.*, u.name AS user_name, u.email AS user_email
      FROM coach_sessions cs JOIN users u ON u.id = cs.user_id
      ORDER BY cs.created_at DESC LIMIT 200
    `;
    return res.status(200).json({ data: rows });
  }

  res.status(404).json({ message: 'Unknown section' });
}

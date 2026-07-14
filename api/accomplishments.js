import { sql, pillarIdFromName } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillarKey = String(req.query.pillar || '').toLowerCase();
  const pillar_id = pillarIdFromName(pillarKey);
  if (!pillar_id) return res.status(404).json({ message: 'Unknown pillar' });

  // A goal's "completion" isn't its own tracked event -- it's derived from its linked
  // Project task (kind='project') reaching status='Completed', same signal /api/projects/
  // [id]/complete.js already sets. That task's updated_at is the real completion timestamp.
  const goalRows = await sql`
    SELECT g.id AS goal_id, g.title, t.id AS project_task_id, t.updated_at AS completed_at, t.xp_gained
    FROM tasks t JOIN goals g ON g.id = t.goal_id
    WHERE t.user_id = ${user.id} AND t.kind = 'project' AND t.status = 'Completed' AND g.pillar_id = ${pillar_id}
  `;
  const questRows = await sql`
    SELECT id, suggestion, xp, completed_at FROM side_quests
    WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND is_completed = true AND completed_at IS NOT NULL
  `;

  // lifescore_boost isn't tracked per-completion-event historically (only the running total
  // is stored on the user row) -- reported as null rather than inventing a number. xp_earned
  // is real and stored on the task/quest row itself.
  const accomplishments = [
    ...goalRows.map(g => ({
      type: 'Main Goal',
      id: g.project_task_id, // the linked Project's task id -- what the detail page routes on
      name: g.title,
      date_completed: g.completed_at,
      rewards: { xp_earned: g.xp_gained, lifescore_boost: null },
    })),
    ...questRows.map(q => ({
      type: 'Side Quest',
      id: q.id,
      name: q.suggestion,
      date_completed: q.completed_at,
      rewards: { xp_earned: q.xp, lifescore_boost: null },
    })),
  ].sort((a, b) => new Date(b.date_completed) - new Date(a.date_completed));

  res.status(200).json(accomplishments);
}

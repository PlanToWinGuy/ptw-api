import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const BINARY_XP = 15;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { taskId, result } = req.body || {};
  if (!taskId || !['success', 'slip_up'].includes(result)) {
    return res.status(422).json({ message: 'taskId and result (success|slip_up) are required' });
  }

  const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id} AND is_anti_goal = true AND anti_goal_type = 'binary'`;
  const task = rows[0];
  if (!task) return res.status(404).json({ message: 'Anti-Goal task not found' });

  const xpGained = result === 'success' ? BINARY_XP : 0;
  await sql`UPDATE tasks SET status = 'Completed', xp_gained = ${xpGained}, updated_at = now() WHERE id = ${taskId}`;
  if (xpGained > 0) await sql`UPDATE users SET xp = xp + ${xpGained} WHERE id = ${user.id}`;

  // Regenerate tomorrow's instance -- binary anti-goals don't ramp, just recur daily.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  await sql`
    INSERT INTO tasks (user_id, pillar_id, quest_id, name, kind, recurrence, due_date, estimated_duration_minutes,
                        is_anti_goal, anti_goal_type)
    VALUES (${task.user_id}, ${task.pillar_id}, ${task.quest_id}, ${task.name}, 'habit', 'daily', ${tomorrow}, ${task.estimated_duration_minutes},
            true, 'binary')
  `;

  res.status(200).json({
    message: 'Your progress has been logged. Remember, every day is a new opportunity.',
    xpGained,
  });
}

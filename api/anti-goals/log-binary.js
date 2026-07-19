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
  // Carries the same start_time/end_time forward (previously dropped entirely, so the
  // regenerated task landed with no scheduled slot at all -- it still showed up on the
  // day, but bucketed into "Unscheduled" instead of its real end-of-day check-in time,
  // easy to overlook and read as if the anti-goal had silently stopped recurring).
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  await sql`
    INSERT INTO tasks (user_id, pillar_id, quest_id, name, kind, recurrence, due_date, estimated_duration_minutes,
                        start_time, end_time, is_anti_goal, anti_goal_type)
    VALUES (${task.user_id}, ${task.pillar_id}, ${task.quest_id}, ${task.name}, 'habit', 'daily', ${tomorrow}, ${task.estimated_duration_minutes},
            ${task.start_time}, ${task.end_time}, true, 'binary')
  `;

  // A real supportive note either way, not one flat line regardless of outcome --
  // matches the 3-tier honesty log-progressive.js already gives progressive anti-goals.
  const message = result === 'success'
    ? "Nice — you held the line today. That's exactly how the habit gets built. 🎉"
    : "Today didn't go how you wanted, and that's okay — one slip doesn't undo the effort. Tomorrow's a clean slate.";

  res.status(200).json({ message, xpGained });
}

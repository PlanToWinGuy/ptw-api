import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { task_id, completion_percentage } = req.body || {};
  if (!task_id) return res.status(422).json({ message: 'task_id is required' });

  const rows = await sql`SELECT * FROM tasks WHERE id = ${task_id} AND user_id = ${user.id}`;
  const task = rows[0];
  if (!task) return res.status(404).json({ message: 'Task not found' });

  const pct = Number(completion_percentage) || 0;
  const status = pct >= 100 ? 'Completed' : 'Pending';
  const xp_gained = pct >= 100 ? Math.round((task.estimated_duration_minutes || 20) * 1.5) + 20 : 0;

  const updated = await sql`
    UPDATE tasks SET status = ${status}, xp_gained = ${xp_gained}, updated_at = now()
    WHERE id = ${task_id} RETURNING *
  `;

  // Habits/recurring tasks regenerate for tomorrow instead of just disappearing once done.
  if (pct >= 100 && task.recurrence === 'daily') {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    await sql`
      INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, recurrence, due_date, estimated_duration_minutes, priority)
      VALUES (${task.user_id}, ${task.goal_id}, ${task.pillar_id}, ${task.name}, ${task.kind}, ${task.recurrence}, ${tomorrow}, ${task.estimated_duration_minutes}, ${task.priority})
    `;
  }

  const userRows = await sql`UPDATE users SET xp = xp + ${xp_gained} WHERE id = ${user.id} RETURNING xp`;

  res.status(200).json({
    data: {
      xp_gained,
      new_total_xp: userRows[0].xp,
      Task: { ...updated[0], pillar_name: PILLARS[updated[0].pillar_id] || null },
    },
  });
}

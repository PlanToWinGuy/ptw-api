import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';

const QUICK_COMPLETE_XP = 10; // flat, per spec 4.6 -- distinct from the full Task
                              // Completion Screen's variable-XP completeTask() flow

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.taskId);
  const rows = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.id}`;
  const task = rows[0];
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (task.status === 'Completed') return res.status(200).json({ message: 'Task completed.', xpGained: 0 });

  await sql`UPDATE tasks SET status = 'Completed', xp_gained = ${QUICK_COMPLETE_XP}, updated_at = now() WHERE id = ${id}`;
  await sql`UPDATE users SET xp = xp + ${QUICK_COMPLETE_XP} WHERE id = ${user.id}`;

  res.status(200).json({ message: 'Task completed.', xpGained: QUICK_COMPLETE_XP });
}

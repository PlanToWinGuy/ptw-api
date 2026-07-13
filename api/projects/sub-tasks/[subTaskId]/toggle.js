import { sql } from '../../../../lib/db.js';
import { cors } from '../../../../lib/cors.js';
import { getUserFromRequest } from '../../../../lib/auth.js';
import { completeTask } from '../../../../lib/tasks.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const subTaskId = Number(req.query.subTaskId);
  const rows = await sql`SELECT * FROM tasks WHERE id = ${subTaskId} AND user_id = ${user.id}`;
  const subTask = rows[0];
  if (!subTask) return res.status(404).json({ message: 'Sub-task not found' });

  if (subTask.status === 'Completed') {
    // Un-complete: revert status and claw back the XP that was awarded, so toggling a
    // checkbox on/off can't be used to farm XP.
    await sql`UPDATE tasks SET status = 'Pending', xp_gained = 0, updated_at = now() WHERE id = ${subTaskId}`;
    if (subTask.xp_gained > 0) {
      await sql`UPDATE users SET xp = GREATEST(0, xp - ${subTask.xp_gained}) WHERE id = ${user.id}`;
    }
  } else {
    await completeTask(sql, user, subTaskId, 100);
  }

  const parentId = subTask.parent_task_id;
  let newProjectProgressPercent = 0;
  if (parentId) {
    const siblings = await sql`SELECT status FROM tasks WHERE parent_task_id = ${parentId}`;
    const total = siblings.length;
    const done = siblings.filter(s => s.status === 'Completed').length;
    newProjectProgressPercent = total ? Math.round((done / total) * 100) : 0;
  }

  res.status(200).json({ message: 'Sub-task status updated successfully.', newProjectProgressPercent });
}

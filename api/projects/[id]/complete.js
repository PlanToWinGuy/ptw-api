import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';

const PROJECT_COMPLETE_XP = 500; // a fixed milestone bonus, not scaled to the project's own
                                  // size/duration -- same precedent as the earlier Work Hub

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const rows = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.id} AND kind = 'project'`;
  const project = rows[0];
  if (!project) return res.status(404).json({ message: 'Project not found' });
  if (project.status === 'Completed') {
    return res.status(200).json({ message: 'Already completed.', xpGained: 0, newTotalXp: user.xp });
  }

  const subTasks = await sql`SELECT * FROM tasks WHERE parent_task_id = ${id}`;
  const tasksTotal = subTasks.length;
  const tasksCompleted = subTasks.filter(t => t.status === 'Completed').length;
  const completedMinutes = subTasks.filter(t => t.status === 'Completed').reduce((s, t) => s + (t.estimated_duration_minutes || 0), 0);

  const [{ session_minutes }] = await sql`
    SELECT COALESCE(SUM(value), 0) AS session_minutes FROM metric_logs
    WHERE user_id = ${user.id} AND log_type = 'work_session' AND (data->>'projectId')::int = ${id}
  `;
  const totalTimeLoggedHours = Math.round(((Number(session_minutes) + completedMinutes) / 60) * 10) / 10;

  await sql`UPDATE tasks SET status = 'Completed', xp_gained = ${PROJECT_COMPLETE_XP}, updated_at = now() WHERE id = ${id}`;
  const userRows = await sql`UPDATE users SET xp = xp + ${PROJECT_COMPLETE_XP} WHERE id = ${user.id} RETURNING xp`;

  res.status(200).json({
    message: 'Project completed successfully!',
    xpGained: PROJECT_COMPLETE_XP,
    newTotalXp: userRows[0].xp,
    summary: {
      projectId: project.id,
      projectName: project.name,
      totalTimeLoggedHours,
      tasksCompleted,
      tasksTotal,
    },
  });
}

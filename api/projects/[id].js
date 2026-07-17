import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const PROJECT_COMPLETE_XP = 500;

// GET fetches the universal Project (a kind='project' task) + its sub-tasks, with the
// derived fields the Preview/Active/Completed states need. PUT updates notes.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const rows = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.id} AND kind = 'project'`;
  const project = rows[0];
  if (!project) return res.status(404).json({ message: 'Project not found' });

  if (req.method === 'PUT') {
    const { notes } = req.body || {};
    await sql`UPDATE tasks SET notes = ${notes ?? null}, updated_at = now() WHERE id = ${id}`;
    return res.status(200).json({ message: 'Project notes updated successfully.' });
  }

  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const subTasks = await sql`SELECT * FROM tasks WHERE parent_task_id = ${id} ORDER BY created_at ASC`;
  const total = subTasks.length;
  const completedCount = subTasks.filter(t => t.status === 'Completed').length;
  const overallProgressPercent = total ? Math.round((completedCount / total) * 100) : (project.status === 'Completed' ? 100 : 0);
  const remainingMinutes = subTasks.filter(t => t.status !== 'Completed').reduce((s, t) => s + (t.estimated_duration_minutes || 0), 0);
  const completedSubtaskMinutes = subTasks.filter(t => t.status === 'Completed').reduce((s, t) => s + (t.estimated_duration_minutes || 0), 0);

  // Time logged: completed sub-tasks' durations + any Work Hub focus sessions tagged
  // with this project's id (session-logging still goes through metric_logs/work_session;
  // only the project *container* moved to the tasks table).
  const [{ session_minutes }] = await sql`
    SELECT COALESCE(SUM(value), 0) AS session_minutes FROM metric_logs
    WHERE user_id = ${user.id} AND log_type = 'work_session' AND (data->>'projectId')::int = ${id}
  `;
  const totalTimeLoggedHours = Math.round(((Number(session_minutes) + completedSubtaskMinutes) / 60) * 10) / 10;

  let status = 'preview';
  if (project.status === 'Completed') status = 'completed';
  else if (project.session_started_at) status = 'in_progress';

  res.status(200).json({
    projectId: project.id,
    projectName: project.name,
    pillar: PILLARS[project.pillar_id] || null,
    status,
    sessionStartedAt: project.session_started_at,
    dueDate: project.due_date,
    startTime: project.start_time,
    endTime: project.end_time,
    completedAt: project.status === 'Completed' ? project.updated_at : null,
    overallProgressPercent,
    estimatedTimeRemainingHours: Math.round((remainingMinutes / 60) * 10) / 10,
    totalTimeLoggedHours,
    rewards: { xp: PROJECT_COMPLETE_XP },
    subTasks: subTasks.map(t => ({
      subTaskId: t.id,
      name: t.name,
      estimatedDurationMinutes: t.estimated_duration_minutes,
      status: t.status,
      phaseLabel: t.phase_label,
      toolHint: t.tool_hint || null,
    })),
    notes: project.notes,
  });
}

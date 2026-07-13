import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const { name, estimatedDurationMinutes } = req.body || {};
  if (!name) return res.status(422).json({ message: 'name is required' });

  const parentRows = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.id} AND kind = 'project'`;
  const parent = parentRows[0];
  if (!parent) return res.status(404).json({ message: 'Project not found' });

  const durationMin = estimatedDurationMinutes || 30;
  const rows = await sql`
    INSERT INTO tasks (user_id, goal_id, pillar_id, parent_task_id, name, kind, estimated_duration_minutes)
    VALUES (${user.id}, ${parent.goal_id}, ${parent.pillar_id}, ${id}, ${name}, 'simple', ${durationMin})
    RETURNING *
  `;
  // Adding a sub-task grows the project's own remaining-time estimate too.
  await sql`UPDATE tasks SET estimated_duration_minutes = COALESCE(estimated_duration_minutes, 0) + ${durationMin} WHERE id = ${id}`;

  res.status(201).json({
    message: 'Sub-task added successfully.',
    subTask: { subTaskId: rows[0].id, name: rows[0].name, estimatedDurationMinutes: rows[0].estimated_duration_minutes, status: rows[0].status },
  });
}

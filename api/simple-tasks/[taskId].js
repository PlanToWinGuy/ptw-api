import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { serializeTask } from '../simple-tasks.js';

const VALID_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.taskId);
  const rows = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.id}`;
  const task = rows[0];
  if (!task) return res.status(404).json({ message: 'Task not found' });

  if (req.method === 'PUT') {
    const body = req.body || {};
    const name = body.name ?? task.name;
    const pillar_id = body.pillar_id !== undefined ? body.pillar_id : task.pillar_id;
    const dur = body.estimatedDurationMinutes ?? body.estimated_duration_minutes ?? task.estimated_duration_minutes;
    const priority = body.priority ?? task.priority;
    const due_date = body.due_date !== undefined ? body.due_date : (body.dueDate !== undefined ? body.dueDate : task.due_date);
    const start_time = body.due_time !== undefined ? body.due_time : (body.dueTime !== undefined ? body.dueTime : task.start_time);
    const description = body.description !== undefined ? body.description : task.notes;
    const icon = body.icon !== undefined ? body.icon : task.icon;
    const color = body.color !== undefined ? body.color : task.color;

    if (!VALID_PRIORITIES.includes(priority)) return res.status(422).json({ message: 'Priority must be one of Low, Medium, High, Urgent.' });

    const updated = await sql`
      UPDATE tasks SET
        name = ${name}, pillar_id = ${pillar_id}, estimated_duration_minutes = ${dur},
        priority = ${priority}, due_date = ${due_date || null}, start_time = ${start_time || null},
        notes = ${description}, icon = ${icon}, color = ${color}, updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    return res.status(200).json(serializeTask(updated[0]));
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM tasks WHERE id = ${id}`;
    return res.status(204).end();
  }

  res.status(405).json({ message: 'Method not allowed' });
}

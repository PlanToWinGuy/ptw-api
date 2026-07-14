import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

const VALID_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

export function serializeTask(t) {
  const pillar_id = t.pillar_id;
  return {
    id: t.id,
    user_id: t.user_id,
    goal_id: t.goal_id,
    parent_task_id: t.parent_task_id,
    session_started_at: t.session_started_at,
    name: t.name,
    description: t.notes,
    icon: t.icon,
    color: t.color,
    kind: t.kind,
    recurrence: t.recurrence,
    phase_label: t.phase_label,
    estimated_duration_minutes: t.estimated_duration_minutes,
    priority: t.priority,
    status: t.status,
    due_date: t.due_date,
    start_time: t.start_time,
    end_time: t.end_time,
    tool_hint: t.tool_hint || null,
    was_skipped: t.was_skipped || false,
    xp_gained: t.xp_gained,
    created_at: t.created_at,
    updated_at: t.updated_at,
    pillar_id,
    pillar_name: PILLARS[pillar_id] || null,
    pillar: pillar_id ? { id: pillar_id, name: PILLARS[pillar_id] } : null,
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM tasks WHERE user_id = ${user.id} ORDER BY created_at DESC`;
    return res.status(200).json(rows.map(serializeTask));
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const name = body.name;
    const pillar_id = body.pillar_id || null;
    const dur = body.estimatedDurationMinutes ?? body.estimated_duration_minutes;
    const priority = body.priority || 'Medium';
    const due_date = body.due_date || body.dueDate || null;
    const start_time = body.due_time || body.dueTime || null;
    const description = body.description ?? null;
    const icon = body.icon || null;
    const color = body.color || null;
    const kind = ['simple', 'project', 'habit'].includes(body.kind) ? body.kind : 'simple';

    const errors = {};
    if (!name) errors.name = ['The name field is required.'];
    if (dur === undefined || dur === null) errors.estimatedDurationMinutes = ['The estimated duration minutes field is required.'];
    if (!VALID_PRIORITIES.includes(priority)) errors.priority = ['Priority must be one of Low, Medium, High, Urgent.'];
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Validation failed', errors });

    const rows = await sql`
      INSERT INTO tasks (user_id, name, pillar_id, estimated_duration_minutes, priority, due_date, start_time, notes, icon, color, kind)
      VALUES (${user.id}, ${name}, ${pillar_id}, ${dur}, ${priority}, ${due_date}, ${start_time}, ${description}, ${icon}, ${color}, ${kind})
      RETURNING *
    `;
    return res.status(200).json(serializeTask(rows[0]));
  }

  res.status(405).json({ message: 'Method not allowed' });
}

import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

// Consolidated routines CRUD -- one serverless function (the project's last available
// slot under Vercel Hobby's 12-function cap). No ?id= -> collection (GET list / POST
// create). ?id=X -> single item (GET / PUT / DELETE). Matches the ?action= dispatch
// pattern used everywhere else this session, just via a path-like param instead.
function serialize(r) {
  const steps = r.steps || [];
  return {
    routineId: r.id,
    name: r.name,
    icon: r.icon,
    category: r.category,
    isActive: r.is_active,
    schedule: { days: r.schedule_days || [], time: r.schedule_time },
    notes: r.notes,
    steps,
    totalDurationMinutes: steps.reduce((s, st) => s + (Number(st.durationMinutes) || 0), 0),
    summary: steps.map(st => st.name).join(', '),
    // goalId/toolHint were being created correctly (see api/goals.js) but silently
    // dropped here, so a goal-generated recurring action (e.g. a daily workout) had no
    // way to be tagged by pillar or routed into its real tool once it reached the client.
    goalId: r.goal_id,
    toolHint: r.tool_hint,
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = req.query.id ? Number(req.query.id) : null;

  if (req.method === 'GET' && !id) {
    const rows = await sql`SELECT * FROM routines WHERE user_id = ${user.id} ORDER BY schedule_time ASC NULLS LAST, created_at ASC`;
    return res.status(200).json(rows.map(serialize));
  }

  if (req.method === 'GET' && id) {
    const rows = await sql`SELECT * FROM routines WHERE id = ${id} AND user_id = ${user.id}`;
    if (!rows[0]) return res.status(404).json({ message: 'Routine not found' });
    return res.status(200).json(serialize(rows[0]));
  }

  if (req.method === 'POST') {
    const { name, icon, category, schedule, isActive, notes, steps } = req.body || {};
    if (!name) return res.status(422).json({ message: 'name is required' });
    const rows = await sql`
      INSERT INTO routines (user_id, name, icon, category, is_active, schedule_days, schedule_time, notes, steps)
      VALUES (${user.id}, ${name}, ${icon || null}, ${category || 'General'}, ${isActive !== false},
              ${schedule?.days || []}, ${schedule?.time || null}, ${notes || null}, ${JSON.stringify(steps || [])}::jsonb)
      RETURNING *
    `;
    return res.status(201).json(serialize(rows[0]));
  }

  if (req.method === 'PUT' && id) {
    const { name, icon, category, schedule, isActive, notes, steps } = req.body || {};
    const rows = await sql`
      UPDATE routines SET
        name = COALESCE(${name}, name),
        icon = ${icon ?? null},
        category = COALESCE(${category}, category),
        is_active = COALESCE(${isActive}, is_active),
        schedule_days = COALESCE(${schedule?.days}, schedule_days),
        schedule_time = COALESCE(${schedule?.time}, schedule_time),
        notes = ${notes ?? null},
        steps = COALESCE(${steps ? JSON.stringify(steps) : null}::jsonb, steps),
        updated_at = now()
      WHERE id = ${id} AND user_id = ${user.id}
      RETURNING *
    `;
    if (!rows[0]) return res.status(404).json({ message: 'Routine not found' });
    return res.status(200).json(serialize(rows[0]));
  }

  if (req.method === 'DELETE' && id) {
    await sql`DELETE FROM routines WHERE id = ${id} AND user_id = ${user.id}`;
    return res.status(204).end();
  }

  res.status(405).json({ message: 'Method not allowed' });
}

import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { date } = req.body || {};
  const targetDate = date || new Date().toISOString().split('T')[0];

  const rows = await sql`
    SELECT * FROM tasks
    WHERE user_id = ${user.id} AND due_date = ${targetDate}
    ORDER BY created_at ASC
  `;

  const data = rows.map(t => ({
    id: t.id,
    task_name: t.name,
    task: t.name,
    category: PILLARS[t.pillar_id] || null,
    pillar: PILLARS[t.pillar_id] || null,
    estimated_duration_minutes: t.estimated_duration_minutes,
    status: t.status,
    priority: t.priority,
  }));

  const total = data.length;
  const completed = data.filter(d => d.status === 'Completed').length;

  res.status(200).json({
    summary_stats: { total, completed, pending: total - completed },
    data,
  });
}

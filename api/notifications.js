import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const rows = await sql`SELECT * FROM notifications WHERE user_id = ${user.id} ORDER BY created_at DESC`;
  res.status(200).json(rows.map(r => ({
    notificationId: r.id,
    iconType: r.icon_type,
    message: r.message,
    timestamp: r.created_at,
    deep_link_target: r.deep_link_target || null,
  })));
}

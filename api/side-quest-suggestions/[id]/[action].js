import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';
import { createNotification } from '../../../lib/notifications.js';

// Handles both /api/side-quest-suggestions/:id/activate and .../:id/complete via
// Vercel's native dynamic route segment -- no rewrite needed, req.query.action is
// populated automatically from the URL.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { id, action } = req.query;

  if (action === 'activate') {
    const rows = await sql`UPDATE side_quests SET is_active = true WHERE id = ${id} AND user_id = ${user.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ message: 'Quest not found' });
    return res.status(200).json(rows[0]);
  }

  if (action === 'complete') {
    const rows = await sql`UPDATE side_quests SET is_completed = true, is_active = false WHERE id = ${id} AND user_id = ${user.id} RETURNING *`;
    if (!rows.length) return res.status(404).json({ message: 'Quest not found' });
    await sql`UPDATE users SET xp = xp + ${rows[0].xp} WHERE id = ${user.id}`;
    await createNotification(sql, user.id, {
      iconType: 'trophy',
      message: `Achievement Unlocked: '${rows[0].suggestion}'!`,
      deepLinkTarget: { page: 'Quests' },
    });
    return res.status(200).json(rows[0]);
  }

  res.status(404).json({ message: 'Unknown quest action' });
}

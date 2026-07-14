import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

// Universal wrapper matching the Create Side Quest Page's exact contract -- same
// effect as the existing pillar-hub tab's [id]/[action]?action=activate, just
// body-based (suggestionId) instead of a URL path id, so both call sites keep working.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { suggestionId } = req.body || {};
  if (!suggestionId) return res.status(422).json({ message: 'suggestionId is required' });

  const rows = await sql`UPDATE side_quests SET is_active = true WHERE id = ${suggestionId} AND user_id = ${user.id} RETURNING *`;
  if (!rows.length) return res.status(404).json({ message: 'Quest not found' });

  res.status(201).json({
    message: 'Side Quest activated successfully!',
    quest: { questId: rows[0].id, title: rows[0].suggestion, status: 'active' },
  });
}

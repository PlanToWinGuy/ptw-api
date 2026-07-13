import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const rows = await sql`
    UPDATE tasks SET session_started_at = now(), updated_at = now()
    WHERE id = ${id} AND user_id = ${user.id} AND kind = 'project'
    RETURNING name
  `;
  if (!rows[0]) return res.status(404).json({ message: 'Project not found' });
  res.status(200).json({ message: `Project session for '${rows[0].name}' has started.` });
}

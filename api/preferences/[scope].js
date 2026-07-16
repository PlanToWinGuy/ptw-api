import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

// Universal preference store (4.19.E-J + units/notifications) -- one table, {scope} is
// either a pillar name lowercase ('fitness', 'diet', ...) or 'units' | 'notifications'.
// GET returns {} (an empty default) if nothing's been saved yet, not a 404 -- every
// preferences page pre-fills a real form, it just starts blank/at defaults.
const VALID_SCOPES = new Set(['fitness', 'diet', 'finances', 'relations', 'personal', 'work', 'units', 'notifications', 'daily_briefings', 'essential_apps']);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const scope = String(req.query.scope || '').toLowerCase();
  if (!VALID_SCOPES.has(scope)) return res.status(404).json({ message: 'Unknown preferences scope' });

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM preferences WHERE user_id = ${user.id} AND scope = ${scope}`;
    return res.status(200).json(rows[0]?.data || {});
  }

  if (req.method === 'PUT') {
    const data = req.body || {};
    await sql`
      INSERT INTO preferences (user_id, scope, data, updated_at)
      VALUES (${user.id}, ${scope}, ${JSON.stringify(data)}::jsonb, now())
      ON CONFLICT (user_id, scope) DO UPDATE SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
    `;
    return res.status(200).json({ message: `Preferences for the ${scope} pillar updated successfully.` });
  }

  res.status(405).json({ message: 'Method not allowed' });
}

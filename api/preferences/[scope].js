import { del } from '@vercel/blob';
import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

// Universal preference store (4.19.E-J + units/notifications) -- one table, {scope} is
// either a pillar name lowercase ('fitness', 'diet', ...) or 'units' | 'notifications'.
// GET returns {} (an empty default) if nothing's been saved yet, not a 404 -- every
// preferences page pre-fills a real form, it just starts blank/at defaults.
const VALID_SCOPES = new Set(['fitness', 'diet', 'finances', 'relations', 'personal', 'work', 'units', 'notifications', 'daily_briefings', 'essential_apps', 'home_background', 'pillar_priority']);

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
    // home_background's photo option is the one preference value backed by real Blob
    // storage (see home-background/upload.js) -- switching away from it here (e.g. to a
    // color preset) would otherwise orphan that blob forever, since this generic PUT
    // path doesn't know about it the way the dedicated upload endpoint does.
    if (scope === 'home_background') {
      const existingRows = await sql`SELECT data FROM preferences WHERE user_id = ${user.id} AND scope = 'home_background'`;
      const existing = existingRows[0]?.data;
      if (existing?.type === 'photo' && existing.blobPathname && existing.blobPathname !== data.blobPathname) {
        await del(existing.blobPathname).catch(() => {});
      }
    }
    await sql`
      INSERT INTO preferences (user_id, scope, data, updated_at)
      VALUES (${user.id}, ${scope}, ${JSON.stringify(data)}::jsonb, now())
      ON CONFLICT (user_id, scope) DO UPDATE SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
    `;
    return res.status(200).json({ message: `Preferences for the ${scope} pillar updated successfully.` });
  }

  res.status(405).json({ message: 'Method not allowed' });
}

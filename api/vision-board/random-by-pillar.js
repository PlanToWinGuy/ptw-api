import { sql, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillar_id = pillarIdFromName(req.query.pillar);

  const rows = pillar_id ? await sql`
    SELECT image_url FROM vision_board_images
    WHERE user_id = ${user.id} AND pillar_id = ${pillar_id}
    ORDER BY random() LIMIT 1
  ` : [];
  // Falls back to any of the user's vision board photos, across every pillar, when
  // this specific one has none tagged -- a task's Success Image used to just silently
  // stay blank the moment the pillar-specific pool was empty, even for someone who'd
  // uploaded plenty of real photos to other pillars. Still motivational (their own real
  // vision), just not pillar-matched for this one completion.
  const fallbackRows = rows.length ? [] : await sql`
    SELECT image_url FROM vision_board_images WHERE user_id = ${user.id} ORDER BY random() LIMIT 1
  `;
  res.status(200).json({ imageUrl: rows[0]?.image_url || fallbackRows[0]?.image_url || null });
}

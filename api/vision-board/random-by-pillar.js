import { sql, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillar_id = pillarIdFromName(req.query.pillar);
  if (!pillar_id) return res.status(200).json({ imageUrl: null });

  const rows = await sql`
    SELECT image_url FROM vision_board_images
    WHERE user_id = ${user.id} AND pillar_id = ${pillar_id}
    ORDER BY random() LIMIT 1
  `;
  res.status(200).json({ imageUrl: rows[0]?.image_url || null });
}

import { del } from '@vercel/blob';
import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'DELETE') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.imageId);
  const rows = await sql`SELECT * FROM vision_board_images WHERE id = ${id} AND user_id = ${user.id}`;
  const image = rows[0];
  if (!image) return res.status(404).json({ message: 'Image not found' });

  await del(image.blob_pathname);
  await sql`DELETE FROM vision_board_images WHERE id = ${id}`;
  res.status(204).end();
}

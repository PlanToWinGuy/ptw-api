import { del } from '@vercel/blob';
import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { verifyPassword } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'DELETE') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { password } = req.body || {};
  if (!password || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ message: 'Incorrect password.' });
  }

  // Vision Board images live in Vercel Blob storage, outside Postgres -- delete those
  // first, since the ON DELETE CASCADE below only cleans up database rows.
  const images = await sql`SELECT blob_pathname FROM vision_board_images WHERE user_id = ${user.id}`;
  for (const img of images) await del(img.blob_pathname).catch(() => {});

  // Every user-owned table cascades on delete except mapper_profiles, which
  // intentionally just disassociates (ON DELETE SET NULL) -- a Valueprint reading is
  // shared infra with map.plantowin.app and survives even if this account doesn't.
  await sql`DELETE FROM users WHERE id = ${user.id}`;

  res.status(204).end();
}

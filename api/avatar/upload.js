import crypto from 'crypto';
import { put, del } from '@vercel/blob';
import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Same upload pattern as home-background/upload.js and vision-board/upload.js -- one
// active photo per user, stored via the generic preferences table (scope 'avatar')
// rather than a dedicated column, matching how home_background already works.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const existingRows = await sql`SELECT data FROM preferences WHERE user_id = ${user.id} AND scope = 'avatar'`;
  const existing = existingRows[0]?.data;

  if (req.method === 'DELETE') {
    await sql`DELETE FROM preferences WHERE user_id = ${user.id} AND scope = 'avatar'`;
    if (existing?.blobPathname) await del(existing.blobPathname).catch(() => {});
    return res.status(200).json({ message: 'Profile photo removed.' });
  }

  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const contentType = req.headers['content-type'] || '';
  const bodyBuffer = await readRawBody(req);
  const formData = await new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bodyBuffer,
  }).formData();

  const file = formData.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') return res.status(422).json({ message: 'image is required' });

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = (file.name || '').split('.').pop() || 'jpg';
  const pathname = `avatar/${user.id}/${crypto.randomUUID()}.${ext}`;
  const blob = await put(pathname, buffer, { access: 'public', contentType: file.type || 'image/jpeg' });

  const data = { url: blob.url, blobPathname: blob.pathname };
  await sql`
    INSERT INTO preferences (user_id, scope, data, updated_at)
    VALUES (${user.id}, 'avatar', ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (user_id, scope) DO UPDATE SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
  `;

  if (existing?.blobPathname) await del(existing.blobPathname).catch(() => {});

  res.status(201).json({ message: 'Profile photo updated.', data });
}

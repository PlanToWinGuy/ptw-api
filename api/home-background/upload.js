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

// Same upload pattern as vision-board/upload.js -- one custom photo per user (not a
// gallery), stored via the generic preferences table (scope 'home_background') rather
// than a dedicated table, since there's only ever one active value at a time.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const contentType = req.headers['content-type'] || '';
  const bodyBuffer = await readRawBody(req);
  const formData = await new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bodyBuffer,
  }).formData();

  const file = formData.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') return res.status(422).json({ message: 'image is required' });

  const existingRows = await sql`SELECT data FROM preferences WHERE user_id = ${user.id} AND scope = 'home_background'`;
  const existing = existingRows[0]?.data;

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = (file.name || '').split('.').pop() || 'jpg';
  const pathname = `home-background/${user.id}/${crypto.randomUUID()}.${ext}`;
  const blob = await put(pathname, buffer, { access: 'public', contentType: file.type || 'image/jpeg' });

  const data = { type: 'photo', url: blob.url, blobPathname: blob.pathname };
  await sql`
    INSERT INTO preferences (user_id, scope, data, updated_at)
    VALUES (${user.id}, 'home_background', ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (user_id, scope) DO UPDATE SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
  `;

  // Clean up the previous photo's blob storage now that it's no longer referenced --
  // otherwise every re-upload orphans the last one permanently.
  if (existing?.type === 'photo' && existing.blobPathname) {
    await del(existing.blobPathname).catch(() => {});
  }

  res.status(201).json({ message: 'Home background updated.', data });
}

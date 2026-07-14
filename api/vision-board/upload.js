import crypto from 'crypto';
import { put } from '@vercel/blob';
import { sql, PILLARS, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

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
  const pillarName = formData.get('pillarName');
  const pillar_id = pillarIdFromName(pillarName);
  if (!pillar_id) return res.status(422).json({ message: 'pillarName must be one of the six pillars' });
  if (!file || typeof file.arrayBuffer !== 'function') return res.status(422).json({ message: 'image is required' });

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = (file.name || '').split('.').pop() || 'jpg';
  const pathname = `vision-board/${user.id}/${crypto.randomUUID()}.${ext}`;
  const blob = await put(pathname, buffer, { access: 'public', contentType: file.type || 'image/jpeg' });

  const rows = await sql`
    INSERT INTO vision_board_images (user_id, pillar_id, image_url, blob_pathname)
    VALUES (${user.id}, ${pillar_id}, ${blob.url}, ${blob.pathname})
    RETURNING *
  `;

  res.status(201).json({
    message: 'Image uploaded successfully.',
    data: { imageId: rows[0].id, imageUrl: rows[0].image_url, pillarName: PILLARS[pillar_id] },
  });
}

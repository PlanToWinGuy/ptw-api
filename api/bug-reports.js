import crypto from 'crypto';
import { put } from '@vercel/blob';
import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest, getAdminFromRequest } from '../lib/auth.js';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// POST /api/bug-reports -- Settings > Report a Problem, plus the couple of dead-end
// entry points that reuse the same screen. Accepts either plain JSON (no screenshot) or
// multipart/form-data (an optional "screenshot" file field alongside the same text
// fields) -- one endpoint either way, same pattern as api/avatar/upload.js. Auth is
// best-effort, not required: a report can legitimately come from a screen reached
// before/without a session (e.g. a login failure).
async function createReport(req, res) {
  const user = await getUserFromRequest(req);
  const contentType = req.headers['content-type'] || '';

  let fields = {};
  let screenshotFile = null;
  if (contentType.includes('multipart/form-data')) {
    const bodyBuffer = await readRawBody(req);
    const formData = await new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bodyBuffer,
    }).formData();
    for (const key of ['description', 'screen', 'app_version', 'user_agent', 'email', 'context']) {
      const v = formData.get(key);
      if (v != null) fields[key] = v;
    }
    const file = formData.get('screenshot');
    if (file && typeof file.arrayBuffer === 'function' && file.size > 0) screenshotFile = file;
  } else {
    fields = req.body || {};
  }

  const description = String(fields.description || '').trim();
  if (!description) {
    return res.status(422).json({ message: 'Validation failed', errors: { description: ['Please describe what happened.'] } });
  }

  let context = null;
  if (fields.context) {
    try { context = typeof fields.context === 'string' ? JSON.parse(fields.context) : fields.context; }
    catch { context = null; }
  }

  if (screenshotFile) {
    try {
      const buffer = Buffer.from(await screenshotFile.arrayBuffer());
      const ext = (screenshotFile.name || '').split('.').pop() || 'png';
      const pathname = `bug-reports/${user?.id || 'anon'}/${crypto.randomUUID()}.${ext}`;
      const blob = await put(pathname, buffer, { access: 'public', contentType: screenshotFile.type || 'image/png' });
      context = { ...(context || {}), screenshot_url: blob.url };
    } catch (e) {
      // A screenshot upload failure shouldn't lose the report itself -- just drop the image.
      console.error('bug-reports: screenshot upload failed', String(e));
    }
  }

  const rows = await sql`
    INSERT INTO bug_reports (user_id, email, description, screen, app_version, user_agent, context)
    VALUES (
      ${user?.id || null},
      ${fields.email || user?.email || null},
      ${description.slice(0, 4000)},
      ${fields.screen ? String(fields.screen).slice(0, 120) : null},
      ${fields.app_version ? String(fields.app_version).slice(0, 40) : null},
      ${fields.user_agent ? String(fields.user_agent).slice(0, 300) : null},
      ${context ? JSON.stringify(context) : null}
    )
    RETURNING id, created_at
  `;
  return res.status(200).json({ data: rows[0] });
}

// GET /api/bug-reports?status=new|reviewed|resolved|all -- admin panel list, newest first.
async function listReports(req, res) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(403).json({ message: 'Forbidden' });
  const status = req.query.status;
  const rows = (status && status !== 'all')
    ? await sql`
        SELECT br.*, u.name AS user_name, u.email AS user_email
        FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id
        WHERE br.status = ${status}
        ORDER BY br.created_at DESC LIMIT 300
      `
    : await sql`
        SELECT br.*, u.name AS user_name, u.email AS user_email
        FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id
        ORDER BY br.created_at DESC LIMIT 300
      `;
  return res.status(200).json({ data: rows });
}

// PATCH /api/bug-reports?id=123  body: {status}. Admin marking a report reviewed/resolved.
async function updateReport(req, res) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(403).json({ message: 'Forbidden' });
  const id = req.query.id || req.body?.id;
  const { status } = req.body || {};
  if (!id || !['new', 'reviewed', 'resolved'].includes(status)) {
    return res.status(422).json({ message: 'Validation failed', errors: { status: ['id and a valid status (new|reviewed|resolved) are required.'] } });
  }
  const rows = status === 'new'
    ? await sql`UPDATE bug_reports SET status = ${status} WHERE id = ${id} RETURNING *`
    : await sql`UPDATE bug_reports SET status = ${status}, reviewed_at = now() WHERE id = ${id} RETURNING *`;
  if (!rows[0]) return res.status(404).json({ message: 'Not found' });
  return res.status(200).json({ data: rows[0] });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method === 'POST') return createReport(req, res);
  if (req.method === 'GET') return listReports(req, res);
  if (req.method === 'PATCH') return updateReport(req, res);
  res.status(405).json({ message: 'Method not allowed' });
}

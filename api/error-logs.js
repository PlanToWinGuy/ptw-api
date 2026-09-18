import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest, getAdminFromRequest } from '../lib/auth.js';

// POST /api/error-logs -- fed by the frontend's window.onerror / unhandledrejection
// handlers (see the ERROR CAPTURE block in ptw-pwa-v2.html). Auth is best-effort: a
// client error can fire before/without a session, so this never requires a token, it
// just attaches one when present. Always responds 200/204 -- a logging call failing
// loudly back at the client would just be a second error to log.
export default async function handler(req, res) {
  if (cors(req, res)) return;

  if (req.method === 'POST') {
    const user = await getUserFromRequest(req);
    const { message, stack, url, user_agent } = req.body || {};
    if (!message) return res.status(204).end();

    const truncMessage = String(message).slice(0, 1000);
    const truncStack = stack ? String(stack).slice(0, 4000) : null;
    const truncUrl = url ? String(url).slice(0, 500) : null;
    const truncAgent = user_agent ? String(user_agent).slice(0, 300) : null;
    const userId = user?.id || 0;

    try {
      // Simple time-window dedupe: the same message from the same user within the last
      // 15 minutes bumps the existing row instead of inserting a new one -- keeps a
      // broken render loop from writing thousands of near-identical rows.
      const existing = await sql`
        SELECT id FROM error_logs
        WHERE message = ${truncMessage} AND COALESCE(user_id, 0) = ${userId}
          AND last_seen_at > now() - interval '15 minutes'
        ORDER BY last_seen_at DESC LIMIT 1
      `;
      if (existing[0]) {
        await sql`UPDATE error_logs SET occurrence_count = occurrence_count + 1, last_seen_at = now() WHERE id = ${existing[0].id}`;
        return res.status(200).json({ data: { deduped: true } });
      }
      const rows = await sql`
        INSERT INTO error_logs (user_id, message, stack, url, user_agent)
        VALUES (${user?.id || null}, ${truncMessage}, ${truncStack}, ${truncUrl}, ${truncAgent})
        RETURNING id
      `;
      return res.status(200).json({ data: rows[0] });
    } catch (e) {
      console.error('error-logs: write failed', String(e));
      return res.status(204).end();
    }
  }

  if (req.method === 'GET') {
    const admin = await getAdminFromRequest(req);
    if (!admin) return res.status(403).json({ message: 'Forbidden' });
    const rows = await sql`
      SELECT el.*, u.name AS user_name, u.email AS user_email
      FROM error_logs el LEFT JOIN users u ON u.id = el.user_id
      ORDER BY el.last_seen_at DESC LIMIT 200
    `;
    return res.status(200).json({ data: rows });
  }

  res.status(405).json({ message: 'Method not allowed' });
}

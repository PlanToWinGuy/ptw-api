import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SCAN_SYSTEM = `You identify food in a photo and estimate its nutrition. Return ONLY JSON, no markdown fences:
{"name":"<short meal name>","calories":<number>,"protein_g":<number>,"carbs_g":<number>,"fat_g":<number>,"confidence":"low"|"medium"|"high","note":"<one short caveat if the estimate is rough, else empty string>"}
Estimates are approximate — say so honestly via confidence/note rather than pretending precision.`;

// Draft-only, not saved -- the client reviews/edits this then POSTs it back to /api/metrics
// (log_type: "meal") to actually save it. Uses Haiku for vision since this doesn't need
// Sonnet-level reasoning and keeping it cheap matters if it's called often.
async function scanMeal(req, res) {
  const { image_base64, media_type } = req.body || {};
  if (!image_base64) return res.status(422).json({ message: 'image_base64 is required' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ message: 'ANTHROPIC_API_KEY not set on the server' });

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system: SCAN_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } },
            { type: 'text', text: 'What is this meal and its approximate nutrition?' },
          ],
        }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    res.status(200).json({ data: parsed });
  } catch (e) {
    res.status(500).json({ message: 'Could not read that photo — try again', error: String(e) });
  }
}

// GET/POST /api/metrics handles logging + fetching; POST /api/metrics/scan-meal
// (rewritten to ?action=scan-meal) handles the AI vision draft step.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  if (req.method === 'POST' && req.query.action === 'scan-meal') return scanMeal(req, res);

  if (req.method === 'GET') {
    const pillar_id = req.query.pillar_id ? Number(req.query.pillar_id) : null;
    const days = Number(req.query.days) || 30;
    const log_type = req.query.log_type || null;

    // log_type filter has no day window (e.g. "My Meals" templates should never expire);
    // everything else is windowed by `days`.
    let logs;
    if (log_type) {
      logs = pillar_id
        ? await sql`SELECT * FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND log_type = ${log_type} ORDER BY logged_at DESC`
        : await sql`SELECT * FROM metric_logs WHERE user_id = ${user.id} AND log_type = ${log_type} ORDER BY logged_at DESC`;
    } else {
      logs = pillar_id
        ? await sql`SELECT * FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND logged_at > now() - (${days} || ' days')::interval ORDER BY logged_at DESC`
        : await sql`SELECT * FROM metric_logs WHERE user_id = ${user.id} AND logged_at > now() - (${days} || ' days')::interval ORDER BY logged_at DESC`;
    }

    const totals = pillar_id
      ? await sql`SELECT log_type, COUNT(*) AS count, SUM(value) AS total, AVG(value) AS avg FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND logged_at > now() - (${days} || ' days')::interval GROUP BY log_type`
      : [];

    return res.status(200).json({ logs, totals });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(422).json({ message: 'id is required' });
    await sql`DELETE FROM metric_logs WHERE id = ${id} AND user_id = ${user.id}`;
    return res.status(200).json({ message: 'deleted' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { pillar_id, log_type, value, unit, data, logged_at } = body;
    if (!log_type) return res.status(422).json({ message: 'log_type is required' });

    const rows = await sql`
      INSERT INTO metric_logs (user_id, pillar_id, log_type, value, unit, data, logged_at)
      VALUES (${user.id}, ${pillar_id || null}, ${log_type}, ${value ?? null}, ${unit || null},
              ${data ? JSON.stringify(data) : null}::jsonb, ${logged_at || new Date().toISOString()})
      RETURNING *
    `;

    // Flat XP per real log entry (never scaled by the metric's own value -- e.g. tying XP to
    // calorie count would reward eating more, which is exactly the pattern Doc3 rules out).
    // Saved templates aren't a logged action, so they don't earn XP.
    let xp_gained = 0;
    if (!log_type.endsWith('_template')) {
      xp_gained = 25;
      await sql`UPDATE users SET xp = xp + ${xp_gained} WHERE id = ${user.id}`;
    }

    return res.status(200).json({ data: rows[0], xp_gained });
  }

  res.status(405).json({ message: 'Method not allowed' });
}

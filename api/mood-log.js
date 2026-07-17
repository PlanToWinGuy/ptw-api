import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

const VALID_MOODS = ['Great', 'Good', 'Okay', 'Tired', 'Stressed'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  // GET powers the Personal hub's Mood Trends view -- the raw check-ins from Take a Break,
  // most recent first, plus a small rollup so the frontend doesn't have to re-derive the
  // same counts/average every render.
  if (req.method === 'GET') {
    const limit = Math.min(Number(req.query.limit) || 30, 90);
    const rows = await sql`
      SELECT mood, created_at FROM mood_logs
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    const MOOD_SCORE = { Great: 5, Good: 4, Okay: 3, Tired: 2, Stressed: 1 };
    const counts = {};
    let scoreSum = 0;
    rows.forEach(r => { counts[r.mood] = (counts[r.mood] || 0) + 1; scoreSum += MOOD_SCORE[r.mood] || 0; });
    const average = rows.length ? Math.round((scoreSum / rows.length) * 10) / 10 : 0;
    return res.status(200).json({ logs: rows, counts, average, total: rows.length });
  }

  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const { mood } = req.body || {};
  if (!VALID_MOODS.includes(mood)) return res.status(422).json({ message: 'A valid mood is required' });

  await sql`INSERT INTO mood_logs (user_id, mood) VALUES (${user.id}, ${mood})`;
  res.status(200).json({ message: 'Mood logged successfully.' });
}

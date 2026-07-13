import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

const VALID_MOODS = ['Great', 'Good', 'Okay', 'Tired', 'Stressed'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { mood } = req.body || {};
  if (!VALID_MOODS.includes(mood)) return res.status(422).json({ message: 'A valid mood is required' });

  await sql`INSERT INTO mood_logs (user_id, mood) VALUES (${user.id}, ${mood})`;
  res.status(200).json({ message: 'Mood logged successfully.' });
}

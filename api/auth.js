import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { hashPassword, verifyPassword, makeToken } from '../lib/auth.js';

// Handles /api/signup and /api/login via vercel.json rewrites (?action=signup|login) --
// consolidated into one function to stay under the Hobby plan's function-count limit.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const action = req.query.action;

  if (action === 'signup') {
    const { name, email, password, password_confirmation } = req.body || {};
    const errors = {};
    if (!name) errors.name = ['The name field is required.'];
    if (!email) errors.email = ['The email field is required.'];
    if (!password || password.length < 8) errors.password = ['Password must be at least 8 characters.'];
    if (password !== password_confirmation) errors.password_confirmation = ['Passwords do not match.'];
    if (Object.keys(errors).length) return res.status(422).json({ message: 'Validation failed', errors });

    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length) return res.status(422).json({ message: 'Email already registered', errors: { email: ['Email already registered.'] } });

    const password_hash = await hashPassword(password);
    const rows = await sql`INSERT INTO users (name, email, password_hash) VALUES (${name}, ${email}, ${password_hash}) RETURNING id`;
    const token = makeToken();
    await sql`INSERT INTO tokens (token, user_id) VALUES (${token}, ${rows[0].id})`;
    return res.status(200).json({ access_token: token, token_type: 'Bearer' });
  }

  if (action === 'login') {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(422).json({ message: 'Validation failed', errors: { email: ['Email and password are required.'] } });
    }
    const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(422).json({ message: 'Invalid credentials', errors: { email: ['These credentials do not match our records.'] } });
    }
    const token = makeToken();
    await sql`INSERT INTO tokens (token, user_id) VALUES (${token}, ${user.id})`;
    return res.status(200).json({ access_token: token, token_type: 'Bearer' });
  }

  res.status(404).json({ message: 'Unknown auth action' });
}

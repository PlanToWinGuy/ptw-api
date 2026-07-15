import { randomUUID } from 'node:crypto';
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

  if (action === 'google') {
    // The frontend only ever hands us a Google ID token (a signed JWT), never a secret --
    // verifying it against Google's own tokeninfo endpoint means Google does the actual
    // signature check server-side for us, no crypto/JWKS handling needed here. The one
    // thing WE must still check ourselves is `aud`: without that, this endpoint would
    // accept a valid Google ID token issued to ANY app, not just this one.
    const { id_token } = req.body || {};
    if (!id_token) return res.status(422).json({ message: 'id_token is required' });
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ message: 'Google sign-in is not configured on the server yet.' });

    let payload;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(id_token));
      if (!r.ok) return res.status(401).json({ message: 'Invalid or expired Google token' });
      payload = await r.json();
    } catch (e) {
      return res.status(502).json({ message: 'Could not verify Google token' });
    }
    if (payload.aud !== clientId) return res.status(401).json({ message: 'Invalid Google token audience' });
    if (payload.email_verified !== 'true' && payload.email_verified !== true) {
      return res.status(401).json({ message: 'Your Google email is not verified' });
    }

    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name || (email || '').split('@')[0];

    let rows = await sql`SELECT * FROM users WHERE google_id = ${googleId}`;
    let user = rows[0];
    let isNewUser = false;

    if (!user) {
      // Same person may already have a password account under this email -- link the
      // Google identity to it instead of creating a second, disconnected account.
      rows = await sql`SELECT * FROM users WHERE email = ${email}`;
      user = rows[0];
      if (user) {
        const linked = await sql`UPDATE users SET google_id = ${googleId} WHERE id = ${user.id} RETURNING *`;
        user = linked[0];
      } else {
        const randomPasswordHash = await hashPassword(randomUUID());
        const created = await sql`
          INSERT INTO users (name, email, password_hash, google_id) VALUES (${name}, ${email}, ${randomPasswordHash}, ${googleId}) RETURNING *
        `;
        user = created[0];
        isNewUser = true;
      }
    }

    const token = makeToken();
    await sql`INSERT INTO tokens (token, user_id) VALUES (${token}, ${user.id})`;
    return res.status(200).json({ access_token: token, token_type: 'Bearer', is_new_user: isNewUser, name: user.name, email: user.email });
  }

  if (action === 'logout') {
    // Opaque bearer tokens, not JWTs -- "revoke" means deleting the row from the
    // tokens table, so this exact token can never authenticate again even if leaked.
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthenticated' });
    await sql`DELETE FROM tokens WHERE token = ${token}`;
    return res.status(200).json({ message: 'Successfully logged out.' });
  }

  res.status(404).json({ message: 'Unknown auth action' });
}

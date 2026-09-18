import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sql } from './db.js';

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

export function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function getUserFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const rows = await sql`
    SELECT u.* FROM tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token = ${token}
  `;
  return rows[0] || null;
}

// Founder-only admin panel gate (bug reports / error log / users / coaching oversight).
// Real auth, not security-by-obscurity: every admin endpoint calls getAdminFromRequest
// itself and re-checks this email server-side on every single request -- there is no
// separate "is_admin" flag anyone can set on a row, only this one hardcoded account.
export const ADMIN_EMAIL = 'founder@plantowin.app';

export function isAdminUser(user) {
  return !!user && String(user.email || '').toLowerCase() === ADMIN_EMAIL;
}

// Like getUserFromRequest, but returns null for anyone who isn't the admin account --
// callers just need one `if (!admin) return res.status(403)...` check.
export async function getAdminFromRequest(req) {
  const user = await getUserFromRequest(req);
  return isAdminUser(user) ? user : null;
}

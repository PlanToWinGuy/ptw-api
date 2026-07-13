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

import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { BREAK_TYPES } from '../../lib/breaks.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { breakType } = req.body || {};
  const type = BREAK_TYPES[breakType];
  if (!type) return res.status(422).json({ message: 'A valid breakType is required' });

  // Simple Shift: the break just consumed real wall-clock time that wasn't in the plan,
  // so push every remaining task scheduled today forward by the break's duration --
  // same "add-time" precedent used elsewhere, just anchored on "now" instead of a task.
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const nowTime = now.toTimeString().slice(0, 8);
  await sql`
    UPDATE tasks SET
      start_time = start_time + (${type.durationMinutes} || ' minutes')::interval,
      end_time = end_time + (${type.durationMinutes} || ' minutes')::interval
    WHERE user_id = ${user.id} AND due_date = ${today} AND status = 'Pending' AND start_time > ${nowTime}
  `;

  let newTotalXp = user.xp;
  if (type.xp > 0) {
    const userRows = await sql`UPDATE users SET xp = xp + ${type.xp} WHERE id = ${user.id} RETURNING xp`;
    newTotalXp = userRows[0].xp;
  }

  res.status(200).json({
    message: 'Break complete — schedule adjusted.',
    xpGained: type.xp,
    newTotalXp,
  });
}

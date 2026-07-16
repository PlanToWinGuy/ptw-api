import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';
import { serializeTask } from '../../simple-tasks.js';
import { clockToMinutes, minutesToClock } from '../../../lib/scheduling.js';

const DAY_END_CLOCK = '21:00';
const MAX_CASCADE = 3; // more tasks than this needing a push = a mass conflict, bail out
                        // instead of silently reshuffling the whole rest of the day

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.taskId);
  const rows = await sql`SELECT * FROM tasks WHERE id = ${id} AND user_id = ${user.id}`;
  const task = rows[0];
  if (!task) return res.status(404).json({ message: 'Task not found' });

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const nowClock = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const durationMin = task.estimated_duration_minutes || 30;
  const newEndMin = clockToMinutes(nowClock) + durationMin;

  // Everything else already on today's real schedule, in order -- a Simple Shift only
  // ever pushes tasks later in the same day to make room, never earlier and never onto
  // a different day. Only tasks still ahead of "now" are candidates -- something whose
  // start_time already passed is either already underway or already missed, and isn't
  // this insertion's problem to push around.
  const todaysTasks = await sql`
    SELECT id, start_time, estimated_duration_minutes FROM tasks
    WHERE user_id = ${user.id} AND due_date = ${today} AND start_time >= ${nowClock} AND status = 'Pending' AND id != ${id}
    ORDER BY start_time ASC
  `;

  // Cascade: any task whose current window now overlaps [now, cursor) gets bumped to
  // start right when the previous one (the new task, or the last bumped one) ends --
  // same "insert and push" idea as Shuffle Day, just for a single new insertion instead
  // of a full-day rebalance.
  let cursor = newEndMin;
  const shifts = [];
  for (const t of todaysTasks) {
    const tStart = clockToMinutes(String(t.start_time).slice(0, 5));
    const tDur = t.estimated_duration_minutes || 30;
    if (tStart >= cursor) break; // sorted ascending -- this and everything after is already clear
    shifts.push({ id: t.id, newStart: cursor, duration: tDur });
    cursor += tDur;
  }

  if (shifts.length > MAX_CASCADE || cursor > clockToMinutes(DAY_END_CLOCK)) {
    return res.status(409).json({
      message: `Starting this now would push ${shifts.length} other task${shifts.length === 1 ? '' : 's'} today` + (cursor > clockToMinutes(DAY_END_CLOCK) ? ', some past a reasonable end of day.' : '.') + ' Reschedule some of today\'s tasks first, or pick a different time.',
      conflictCount: shifts.length,
    });
  }

  for (const s of shifts) {
    const newStartClock = minutesToClock(s.newStart);
    const newEndClock = minutesToClock(s.newStart + s.duration);
    await sql`UPDATE tasks SET start_time = ${newStartClock}, end_time = ${newEndClock}, updated_at = now() WHERE id = ${s.id}`;
  }

  const newEndClock = minutesToClock(newEndMin);
  const updated = await sql`
    UPDATE tasks SET due_date = ${today}, start_time = ${nowClock}, end_time = ${newEndClock}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  res.status(200).json({ ...serializeTask(updated[0]), shiftedCount: shifts.length });
}

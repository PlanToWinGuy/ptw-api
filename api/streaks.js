import { sql, pillarIdFromName } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { computeConsecutiveDayRuns } from '../lib/streaks.js';

const PRIMARY_LOG_TYPE = { fitness: 'workout', diet: 'meal', finances: 'transaction', relations: 'connection', personal: 'personal_log', work: 'work_session' };
const PRIMARY_STREAK_NAME = { fitness: 'Workout Streak', diet: 'Meal Logging Streak', finances: 'Expense Tracking Streak', relations: 'Connection Streak', personal: 'Personal Practice Streak', work: 'Deep Work Streak' };

function dateStr(d) { return (d instanceof Date ? d.toISOString() : String(d)).split('T')[0]; }
function fmtDays(n) { return `${n} Day${n === 1 ? '' : 's'}`; }

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillarKey = String(req.query.pillar || '').toLowerCase();
  const pillar_id = pillarIdFromName(pillarKey);
  const logType = PRIMARY_LOG_TYPE[pillarKey];
  if (!pillar_id || !logType) return res.status(404).json({ message: 'Unknown pillar' });

  const logs = await sql`SELECT logged_at FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND log_type = ${logType}`;
  const primaryDates = logs.map(l => dateStr(l.logged_at));
  const namedRuns = [{ name: PRIMARY_STREAK_NAME[pillarKey], ...computeConsecutiveDayRuns(primaryDates) }];

  // Routine-based streaks -- any routine belonging to this pillar contributes its own named
  // streak from its materialized-task completion history, so a real per-habit streak (e.g.
  // "Daily Step Goal Met") shows up distinctly from the pillar's general activity streak.
  const routines = await sql`SELECT id, name FROM routines WHERE user_id = ${user.id} AND category ILIKE ${pillarKey}`;
  for (const r of routines) {
    const rTasks = await sql`SELECT due_date FROM tasks WHERE user_id = ${user.id} AND routine_id = ${r.id} AND status = 'Completed'`;
    const rDates = rTasks.map(t => dateStr(t.due_date));
    if (!rDates.length) continue;
    namedRuns.push({ name: r.name, ...computeConsecutiveDayRuns(rDates) });
  }

  const activeRaw = namedRuns.filter(s => s.active).map(s => ({ name: s.name, start_date: s.active.startDate, length: s.active.length }));
  const pastRaw = namedRuns.flatMap(s => s.runs.filter(r => r !== s.active).map(r => ({ name: s.name, start_date: r.startDate, end_date: r.endDate, length: r.length })))
    .sort((a, b) => b.end_date.localeCompare(a.end_date));

  const longestCurrentRaw = activeRaw.reduce((best, s) => (!best || s.length > best.length) ? s : best, null);
  const longestEverRaw = namedRuns.reduce((best, s) => (s.longestEver && (!best || s.longestEver.length > best.length)) ? { name: s.name, length: s.longestEver.length } : best, null);

  res.status(200).json({
    longest_current_streak: longestCurrentRaw ? { name: longestCurrentRaw.name, length: fmtDays(longestCurrentRaw.length) } : null,
    longest_ever_streak: longestEverRaw ? { name: longestEverRaw.name, length: fmtDays(longestEverRaw.length) } : null,
    active_streaks: activeRaw.map(s => ({ name: s.name, start_date: s.start_date, current_length: fmtDays(s.length) })),
    past_streaks: pastRaw.map(s => ({ name: s.name, start_date: s.start_date, end_date: s.end_date, final_length: fmtDays(s.length) })),
  });
}

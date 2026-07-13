import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { getPillarState } from '../lib/pillarState.js';
import { materializeRoutinesForDate } from '../lib/routines.js';

const PRIORITY_FLAG = { High: '🚩', Medium: '🏳️', Low: '🏳️' };

function timeBlock(startTime) {
  if (!startTime) return null;
  const hour = Number(String(startTime).split(':')[0]);
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

function taskType(kind) {
  if (kind === 'project') return 'ProjectTask';
  if (kind === 'habit') return 'Logging'; // every pillar now has a dedicated Hub log flow
  return 'Simple';
}

function formatDuration(totalMinutes) {
  const h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { date } = req.body || {};
  const targetDate = date || new Date().toISOString().split('T')[0];

  await materializeRoutinesForDate(user, targetDate);

  const rows = await sql`
    SELECT * FROM tasks
    WHERE user_id = ${user.id} AND due_date = ${targetDate} AND status != 'Skipped'
    ORDER BY start_time ASC NULLS LAST, created_at ASC
  `;

  const data = rows.map(t => {
    const durationMin = t.estimated_duration_minutes || 20;
    return {
      taskId: t.id,
      routineId: t.routine_id || null,
      name: t.name,
      description: (t.routine_id ? 'Routine' : t.kind === 'project' ? 'Main Goal' : t.goal_id ? 'Main Goal' : 'Quick Task') + ' | ' + durationMin + ' min',
      startTime: t.start_time,
      endTime: t.end_time,
      durationMinutes: durationMin,
      taskType: taskType(t.kind),
      pillar: PILLARS[t.pillar_id] || null,
      priority: t.priority || null,
      time_block: timeBlock(t.start_time),
      status: t.status,
      xpValue: Math.round(durationMin * 1.5) + 20,
      customIcon: t.pillar_id ? (PILLARS[t.pillar_id] || '').toLowerCase() + '_icon' : (t.priority ? PRIORITY_FLAG[t.priority] : null),
    };
  });

  const total_tasks = data.length;
  const completed = data.filter(d => d.status === 'Completed').length;
  const completion_percent = total_tasks ? Math.round((completed / total_tasks) * 100) : 0;
  const totalMinutes = rows.reduce((s, t) => s + (t.estimated_duration_minutes || 0), 0);

  // Real daily XP + streak, for the Wind-Down recap (no new endpoint needed --
  // 4.5.5's "Daily Summary" numbers just ride along on this same response).
  const [{ xp_from_tasks }] = await sql`SELECT COALESCE(SUM(xp_gained), 0) AS xp_from_tasks FROM tasks WHERE user_id = ${user.id} AND due_date = ${targetDate} AND status = 'Completed'`;
  const [{ xp_from_logs }] = await sql`SELECT COALESCE(SUM(xp_gained), 0) AS xp_from_logs FROM metric_logs WHERE user_id = ${user.id} AND logged_at::date = ${targetDate}`;
  const xp_earned = Number(xp_from_tasks) + Number(xp_from_logs);

  const activeDayRows = await sql`
    SELECT DISTINCT d FROM (
      SELECT due_date AS d FROM tasks WHERE user_id = ${user.id} AND status = 'Completed' AND due_date IS NOT NULL
      UNION
      SELECT logged_at::date AS d FROM metric_logs WHERE user_id = ${user.id}
    ) x
  `;
  const activeDays = new Set(activeDayRows.map(r => new Date(r.d).toISOString().split('T')[0]));
  let streak_days = 0, cursorDay = new Date();
  while (activeDays.has(cursorDay.toISOString().split('T')[0])) { streak_days++; cursorDay.setDate(cursorDay.getDate() - 1); }

  // pillar_states: "glowing" nudges the user toward the AI-recommended pillar once
  // they're actually eligible to activate it; "active" for anything already unlocked.
  const { unlockedPillars, canActivateNextPillar } = await getPillarState(user);
  const recommended = (user.recommended_pillar || '').toLowerCase();
  const pillar_states = Object.entries(PILLARS).map(([id, name]) => {
    const key = name.toLowerCase();
    const status = unlockedPillars.includes(key) ? 'active'
      : (key === recommended && canActivateNextPillar) ? 'glowing'
      : 'inactive';
    return { pillarName: name, status };
  });

  res.status(200).json({
    message: 'Projects and schedules retrieved successfully.',
    summary_stats: { total_tasks, completed_count: completed, completion_percent, total_scheduled_time: formatDuration(totalMinutes), xp_earned, streak_days },
    data,
    pillar_states,
  });
}

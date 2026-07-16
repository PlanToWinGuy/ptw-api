import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { getPillarState, buildPillarStates } from '../lib/pillarState.js';
import { materializeRoutinesForDate } from '../lib/routines.js';
import { applyPlanShiftForUser, notifyStrictDeadlineRisk, rescheduleMissedSimpleTasks } from '../lib/planShift.js';
import { computeStreakDays } from '../lib/tasks.js';
import { reconcileStreakTokens } from '../lib/streakTokens.js';

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
  await applyPlanShiftForUser(sql, user, targetDate);
  await rescheduleMissedSimpleTasks(sql, user, targetDate);
  await notifyStrictDeadlineRisk(sql, user, targetDate);
  await reconcileStreakTokens(sql, user);

  // A Project's due_date is set once, at goal-generation time -- it isn't a single day's
  // appointment like a simple/habit task, it's "when this project started". Without this,
  // an incomplete multi-week Project would only ever appear on Daily Overview on the one
  // day it was created and then silently vanish forever. So Projects stay visible every day
  // from their due_date onward until they're actually completed (or explicitly skipped).
  // Same logic applies to an undated backlog task (due_date IS NULL, e.g. added via the
  // to-do modal with the date cleared, or created by AI chat without a date) -- it stays
  // visible every day until it's given a real date, completed, or deleted, instead of being
  // permanently invisible because NULL never equals an exact targetDate match.
  // A Project's own sub-tasks used to be excluded entirely -- the only thing Daily
  // Overview ever showed for an active goal was one generic "Main Goal" placeholder card,
  // with the actual day's real action buried inside the Project Detail page. That meant a
  // goal's tasks never showed up as real, individually-loggable Daily Overview items the
  // way the rest of this app's tool_hint routing is built around. Now a sub-task due today
  // shows up as its own real card (tappable into its exact tool, same as any other
  // tool_hint task); the generic parent Project card is suppressed for that day so the
  // same project doesn't appear twice, and only reappears on days with no specific
  // sub-task due (e.g. between phases).
  const rows = await sql`
    SELECT * FROM tasks
    WHERE user_id = ${user.id} AND status != 'Skipped'
      AND (
        (kind = 'project' AND parent_task_id IS NULL AND due_date <= ${targetDate})
        OR (kind != 'project' AND parent_task_id IS NULL AND due_date = ${targetDate})
        OR (kind != 'project' AND parent_task_id IS NULL AND due_date IS NULL)
        OR (parent_task_id IS NOT NULL AND due_date = ${targetDate})
      )
    ORDER BY start_time ASC NULLS LAST, created_at ASC
  `;
  const parentsRepresentedToday = new Set(rows.filter(t => t.parent_task_id).map(t => t.parent_task_id));
  const visibleRows = rows.filter(t => !(t.kind === 'project' && parentsRepresentedToday.has(t.id)));

  const data = visibleRows.map(t => {
    const durationMin = t.estimated_duration_minutes || 20;
    return {
      taskId: t.id,
      routineId: t.routine_id || null,
      name: t.name,
      description: (t.routine_id ? 'Routine' : t.kind === 'project' ? 'Main Goal' : t.goal_id ? (t.phase_label || 'Plan Action') : 'Quick Task') + ' | ' + durationMin + ' min',
      goalId: t.goal_id || null,
      phaseLabel: t.phase_label || null,
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
      isAntiGoal: t.is_anti_goal || false,
      antiGoalType: t.anti_goal_type || null,
      baselineValue: t.baseline_value,
      targetValue: t.target_value,
      toolHint: t.tool_hint || null,
      wasSkipped: t.was_skipped || false,
    };
  });

  const total_tasks = data.length;
  const completed = data.filter(d => d.status === 'Completed').length;
  const completion_percent = total_tasks ? Math.round((completed / total_tasks) * 100) : 0;
  const totalMinutes = visibleRows.reduce((s, t) => s + (t.estimated_duration_minutes || 0), 0);

  // Real daily XP + streak, for the Wind-Down recap (no new endpoint needed --
  // 4.5.5's "Daily Summary" numbers just ride along on this same response).
  const [{ xp_from_tasks }] = await sql`SELECT COALESCE(SUM(xp_gained), 0) AS xp_from_tasks FROM tasks WHERE user_id = ${user.id} AND due_date = ${targetDate} AND status = 'Completed'`;
  const [{ xp_from_logs }] = await sql`SELECT COALESCE(SUM(xp_gained), 0) AS xp_from_logs FROM metric_logs WHERE user_id = ${user.id} AND logged_at::date = ${targetDate}`;
  const xp_earned = Number(xp_from_tasks) + Number(xp_from_logs);

  const streak_days = await computeStreakDays(sql, user);

  // pillar_states: "glowing" nudges the user toward the AI-recommended pillar once
  // they're actually eligible to activate it; "active" for anything already unlocked.
  // Shared with api/user.js so Home/Daily Overview and the Profile page always agree.
  const pillarState = await getPillarState(user);
  const pillar_states = buildPillarStates(pillarState, user.recommended_pillar);

  res.status(200).json({
    message: 'Projects and schedules retrieved successfully.',
    summary_stats: { total_tasks, completed_count: completed, completion_percent, total_scheduled_time: formatDuration(totalMinutes), xp_earned, streak_days },
    data,
    pillar_states,
  });
}

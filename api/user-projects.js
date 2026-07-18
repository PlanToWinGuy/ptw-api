import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { getPillarState, buildPillarStates } from '../lib/pillarState.js';
import { materializeRoutinesForDate } from '../lib/routines.js';
import { applyPlanShiftForUser, notifyStrictDeadlineRisk, rescheduleMissedSimpleTasks } from '../lib/planShift.js';
import { computeStreakDays } from '../lib/tasks.js';
import { reconcileStreakTokens } from '../lib/streakTokens.js';
import { findOpenSlot, addMinutesToClock } from '../lib/scheduling.js';

const PRIORITY_FLAG = { High: '🚩', Medium: '🏳️', Low: '🏳️' };
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A Project's own parent row carries its full remaining scope in
// estimated_duration_minutes (real and correct -- that's the whole project, not a single
// sitting), but on a day where it's the only thing representing that project (no specific
// sub-task due -- see parentsRepresentedToday below), it used to show up with no
// start/end time at all. With no end time, applyCtaState()'s "current task" fallback on
// the frontend would lock onto it as if it were `!t.startTime`-eligible and never release
// it -- reading as "the whole project just sits there taking up the whole day, forever."
// A real, bounded work-session block (capped well under the full project scope) fixes
// both: it now competes for a real calendar slot like anything else, and naturally expires
// into the overtime state after a normal work session instead of staying locked forever.
const PROJECT_SESSION_MINUTES = 120;

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

  const data = await Promise.all(visibleRows.map(async t => {
    // Only projects showing as their own "Main Goal" placeholder (no sub-task due today)
    // need a synthesized slot -- a project WITH a sub-task due today is suppressed above
    // in favor of that sub-task, which already carries its own real start/end time.
    let startTime = t.start_time, endTime = t.end_time;
    let durationMin = t.estimated_duration_minutes || 20;
    // Caps regardless of whether a start_time already exists on the row -- an older
    // project row can carry a stale multi-hour span from before this cap existed, not
    // just a completely empty one, and both need the same real bounded session.
    if (t.kind === 'project' && durationMin > PROJECT_SESSION_MINUTES) {
      durationMin = PROJECT_SESSION_MINUTES;
      if (!startTime) {
        const slot = await findOpenSlot(sql, user.id, { earliestDate: targetDate, searchDays: 1, durationMinutes: durationMin });
        startTime = slot.startTime;
      }
      endTime = addMinutesToClock(startTime, durationMin);
    }
    return {
      taskId: t.id,
      routineId: t.routine_id || null,
      name: t.name,
      description: (t.routine_id ? 'Routine' : t.kind === 'project' ? 'Main Goal' : t.goal_id ? (t.phase_label || 'Plan Action') : 'Quick Task') + ' | ' + durationMin + ' min',
      goalId: t.goal_id || null,
      phaseLabel: t.phase_label || null,
      startTime,
      endTime,
      durationMinutes: durationMin,
      taskType: taskType(t.kind),
      pillar: PILLARS[t.pillar_id] || null,
      priority: t.priority || null,
      time_block: timeBlock(startTime),
      status: t.status,
      xpValue: Math.round(durationMin * 1.5) + 20,
      customIcon: t.pillar_id ? (PILLARS[t.pillar_id] || '').toLowerCase() + '_icon' : (t.priority ? PRIORITY_FLAG[t.priority] : null),
      isAntiGoal: t.is_anti_goal || false,
      antiGoalType: t.anti_goal_type || null,
      baselineValue: t.baseline_value,
      targetValue: t.target_value,
      toolHint: t.tool_hint || null,
      wasSkipped: t.was_skipped || false,
      wasPartial: t.was_partial || false,
      partialCompletionPercentage: t.partial_completion_percentage ?? null,
    };
  }));

  const total_tasks = data.length;
  const completed = data.filter(d => d.status === 'Completed').length;
  const completion_percent = total_tasks ? Math.round((completed / total_tasks) * 100) : 0;
  // From `data` (not visibleRows) so a Project placeholder's capped session length is
  // what counts toward "scheduled today," not its full remaining project scope.
  const totalMinutes = data.reduce((s, d) => s + (d.durationMinutes || 0), 0);

  // Fixed Commitments (an uploaded class/work/practice schedule, or a manually-added
  // recurring block like a weekly guitar lesson) were only ever used internally by
  // findOpenSlot to avoid double-booking against them -- they never actually rendered
  // anywhere, so an uploaded schedule felt like it vanished into the scheduler instead of
  // showing up as real items on the day. They're read-only (no XP, no complete/skip --
  // they're external obligations, not something this app tracks progress on), merged
  // into `data` so they interleave chronologically with everything else exactly like a
  // real calendar would.
  const weekday = WEEKDAY_NAMES[new Date(targetDate + 'T00:00:00').getDay()];
  const commitmentRows = await sql`
    SELECT * FROM fixed_commitments
    WHERE user_id = ${user.id} AND (schedule_days = '{}' OR ${weekday} = ANY(schedule_days))
    ORDER BY start_time ASC
  `;
  const commitments = commitmentRows.map(c => {
    const startTime = String(c.start_time).slice(0, 5);
    const endTime = String(c.end_time).slice(0, 5);
    const durationMin = Math.round((new Date('2000-01-01T' + c.end_time) - new Date('2000-01-01T' + c.start_time)) / 60000);
    return {
      taskId: 'commitment-' + c.id,
      routineId: null,
      name: c.name,
      description: 'Fixed Commitment | ' + durationMin + ' min',
      goalId: null,
      phaseLabel: null,
      startTime,
      endTime,
      durationMinutes: durationMin,
      taskType: 'Commitment',
      pillar: PILLARS[c.pillar_id] || null,
      priority: null,
      time_block: timeBlock(startTime),
      status: 'Fixed',
      xpValue: 0,
      customIcon: null,
      isAntiGoal: false,
      antiGoalType: null,
      toolHint: null,
      wasSkipped: false,
      wasPartial: false,
      partialCompletionPercentage: null,
    };
  });
  const dataWithCommitments = [...data, ...commitments].sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));

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

  // A past day only -- looking at "today" or the future, every task still due here is
  // already in `data` above; it's specifically a PAST day where an auto-reschedule (Plan
  // Shift, the missed-simple-task sweep, Shuffle Day, a manual move, or a second Skip)
  // can make a task vanish from the one day it actually shows in this endpoint's normal
  // query. movedAway surfaces those as read-only "moved to [date]" entries so the day's
  // real history stays visible instead of silently going blank.
  let movedAway = [];
  const todayStr = new Date().toISOString().split('T')[0];
  if (targetDate < todayStr) {
    const moved = await sql`
      SELECT DISTINCT ON (task_id) task_id, task_name, pillar_id, to_date, reason, created_at
      FROM task_reschedule_log
      WHERE user_id = ${user.id} AND from_date = ${targetDate}
      ORDER BY task_id, created_at DESC
    `;
    movedAway = moved.map(m => ({
      taskId: m.task_id,
      taskName: m.task_name,
      pillar: PILLARS[m.pillar_id] || null,
      toDate: m.to_date ? (m.to_date instanceof Date ? m.to_date.toISOString().split('T')[0] : String(m.to_date).split('T')[0]) : null,
      reason: m.reason,
    }));
  }

  res.status(200).json({
    message: 'Projects and schedules retrieved successfully.',
    summary_stats: { total_tasks, completed_count: completed, completion_percent, total_scheduled_time: formatDuration(totalMinutes), xp_earned, streak_days },
    data: dataWithCommitments,
    movedAway,
    pillar_states,
  });
}

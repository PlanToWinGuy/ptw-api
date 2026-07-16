import { createNotification } from './notifications.js';
import { calculateTaskXp } from './lifescore.js';
import { findOpenSlot, slotSearchWindowForPriority } from './scheduling.js';

// Shared task-completion logic, used by both api/tasks/update-completion.js (the
// checkmark/slider flow) and api/metrics.js (a pillar Hub logging action that's tied
// to a scheduled Logging Task, via task_id -- see schema.sql's metric_logs.task_id).

// Completes (or partially completes) a task and awards its XP. Returns null if the
// task doesn't belong to this user. actualMinutesSpent, when known (the Home ring's
// manual "Start" timer tracks this for real), replaces the old blind assumption that
// the task was progressing exactly on pace with its own estimate.
export async function completeTask(sql, user, taskId, completionPercentage = 100, actualMinutesSpent = null) {
  const rows = await sql`
    SELECT t.*, g.difficulty AS goal_difficulty FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.id = ${taskId} AND t.user_id = ${user.id}
  `;
  const task = rows[0];
  if (!task) return null;

  const pct = Number(completionPercentage) || 0;
  // Any real completion action -- 100% or partial -- closes out THIS scheduled
  // instance. Partial completion spins off a separate "(continued)" task for the
  // leftover time below; leaving the original row 'Pending' here (as this used to do)
  // meant it never left the task bank, so rescheduleMissedSimpleTasks/applyPlanShift
  // kept bumping it forward a day at a time, forever -- a task the user thought they'd
  // logged progress on would silently drift across the calendar (surfacing days later,
  // seemingly at random) while ALSO existing as its own separate remainder task.
  const status = pct > 0 ? 'Completed' : 'Pending';
  // Section 3.0: XP Earned = Base Task XP x Task Difficulty Multiplier x Goal Difficulty
  // Multiplier -- tool_hint picks the base amount (falls back to 'default' for untagged
  // tasks), estimated_duration_minutes stands in for task difficulty, the linked goal's
  // own difficulty rating stands in for goal difficulty.
  const xp_gained = pct >= 100 ? calculateTaskXp({
    taskType: task.tool_hint,
    durationMinutes: task.estimated_duration_minutes,
    goalDifficulty: task.goal_difficulty,
  }) : 0;

  const updated = await sql`
    UPDATE tasks SET status = ${status}, xp_gained = ${xp_gained}, updated_at = now()
    WHERE id = ${taskId} RETURNING *
  `;

  // Habits/recurring tasks regenerate for tomorrow instead of just disappearing once done.
  if (pct >= 100 && task.recurrence === 'daily') {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    await sql`
      INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, recurrence, due_date, estimated_duration_minutes, priority)
      VALUES (${task.user_id}, ${task.goal_id}, ${task.pillar_id}, ${task.name}, ${task.kind}, ${task.recurrence}, ${tomorrow}, ${task.estimated_duration_minutes}, ${task.priority})
    `;
  }

  // Partial completion (< 100%): create a same-kind follow-up task for the leftover
  // work, rather than silently losing it -- rescheduled into a real open slot exactly
  // like a skipped task, not just left slot-less on the same day.
  //
  // Remaining-time math: if we know how long the task ACTUALLY took so far (the Home
  // ring's manual timer), the remainder is based on the real pace, not the original
  // estimate -- e.g. 30 real minutes spent to reach 50% means the task is running at
  // 60 min total, so 30 more minutes are needed (60 - 30), not 15 (a blind 50% of the
  // original 30-min estimate). Without a real elapsed time to go on (the task was never
  // actually started/timed), fall back to the old proportional-of-estimate guess.
  let remainderTask = null;
  if (pct > 0 && pct < 100 && task.estimated_duration_minutes) {
    const spent = Number(actualMinutesSpent) > 0 ? Number(actualMinutesSpent) : null;
    const remainingMinutes = spent
      ? Math.round((spent / pct) * (100 - pct))
      : Math.round(task.estimated_duration_minutes * (1 - pct / 100));
    if (remainingMinutes >= 5) {
      const todayStr = new Date().toISOString().split('T')[0];
      const slot = await findOpenSlot(sql, task.user_id, {
        earliestDate: todayStr,
        durationMinutes: remainingMinutes,
        ...slotSearchWindowForPriority(task.priority),
      });
      const remRows = await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, priority, due_date, start_time, estimated_duration_minutes)
        VALUES (${task.user_id}, ${task.goal_id}, ${task.pillar_id}, ${task.name + ' (continued)'}, ${task.kind}, ${task.priority}, ${slot.date}, ${slot.startTime}, ${remainingMinutes})
        RETURNING *
      `;
      remainderTask = remRows[0];
    }
  }

  if (xp_gained > 0) {
    await sql`UPDATE users SET xp = xp + ${xp_gained} WHERE id = ${user.id}`;
  }

  // Only notify on genuinely notable completions (a habit streak tick or a big XP
  // win) -- every checkbox tap would make the Notifications screen noise, not signal.
  if (pct >= 100 && (task.kind === 'habit' || xp_gained >= 50)) {
    await createNotification(sql, user.id, {
      iconType: 'task',
      message: `Completed '${task.name}' — +${xp_gained} XP`,
    });
  }

  return { task: updated[0], xp_gained, remainderTask };
}

// Cross-pillar daily engagement streak: consecutive days (walking back from today)
// with at least one completed task or logged action. Shared by user-projects.js's
// summary_stats and the Profile page's performance-metrics grid ("does not change
// per pillar" per that spec).
export async function computeStreakDays(sql, user) {
  const activeDayRows = await sql`
    SELECT DISTINCT d FROM (
      SELECT due_date AS d FROM tasks WHERE user_id = ${user.id} AND status = 'Completed' AND due_date IS NOT NULL
      UNION
      SELECT logged_at::date AS d FROM metric_logs WHERE user_id = ${user.id}
    ) x
  `;
  const activeDays = new Set(activeDayRows.map(r => new Date(r.d).toISOString().split('T')[0]));
  let streak = 0, cursorDay = new Date();
  while (activeDays.has(cursorDay.toISOString().split('T')[0])) { streak++; cursorDay.setDate(cursorDay.getDate() - 1); }
  return streak;
}

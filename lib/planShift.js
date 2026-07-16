import { createNotification } from './notifications.js';
import { findOpenSlot, addMinutesToClock } from './scheduling.js';

// Dynamic Timeline's Plan Shift (2.9.2) -- lazy and idempotent, same pattern as
// materializeRoutinesForDate: called on every /api/user-projects load rather than a
// cron job (no scheduled-job infra exists in this project). For each Project whose goal
// is Dynamic and has at least one still-Pending sub-task that's overdue (due_date <
// targetDate), the entire remaining sequence of that project's pending sub-tasks shifts
// forward by one day, and the goal's own end_date (Projected Completion Date) shifts
// forward by one day too. Naturally idempotent: once a shifted task's due_date reaches
// targetDate it's no longer "missed", so repeated calls converge without needing any
// extra tracking state. Strict-timeline goals are untouched here -- see
// api/tasks/update-completion.js's Strict-deadline notification instead.
export async function applyPlanShiftForUser(sql, user, targetDate) {
  const overdueProjects = await sql`
    SELECT DISTINCT t.parent_task_id AS project_id, t.goal_id AS goal_id
    FROM tasks t
    JOIN goals g ON g.id = t.goal_id
    WHERE t.user_id = ${user.id} AND t.status = 'Pending' AND t.due_date < ${targetDate}
      AND t.parent_task_id IS NOT NULL AND g.timeline_type = 'dynamic' AND g.is_active = true
  `;

  for (const row of overdueProjects) {
    if (!row.project_id) continue;
    await sql`
      UPDATE tasks SET due_date = due_date + INTERVAL '1 day', updated_at = now()
      WHERE parent_task_id = ${row.project_id} AND status = 'Pending'
    `;
    if (row.goal_id) {
      await sql`UPDATE goals SET end_date = end_date + INTERVAL '1 day' WHERE id = ${row.goal_id} AND end_date IS NOT NULL`;
    }

    // The uniform +1 day above preserves this project's own internal day-to-day
    // spacing, but it only touches due_date -- each sub-task's start_time is left as
    // whatever it was on its old day, which can now collide with something unrelated
    // (another pillar's task, a routine, a fixed commitment) already sitting at that
    // clock time on the new day. Re-resolving each shifted sub-task's own start_time
    // through findOpenSlot (same fixer already applied to goal generation and routine
    // materialization this pass) closes that gap without disturbing the day-to-day
    // shift itself.
    const shifted = await sql`
      SELECT id, due_date, start_time, estimated_duration_minutes FROM tasks
      WHERE parent_task_id = ${row.project_id} AND status = 'Pending' AND start_time IS NOT NULL
    `;
    for (const t of shifted) {
      const dueDateStr = t.due_date instanceof Date ? t.due_date.toISOString().split('T')[0] : String(t.due_date).split('T')[0];
      const preferredClock = String(t.start_time).slice(0, 5);
      const durationMin = t.estimated_duration_minutes || 30;
      const slot = await findOpenSlot(sql, user.id, {
        earliestDate: dueDateStr, searchDays: 1, durationMinutes: durationMin, dayStartClock: preferredClock, excludeTaskId: t.id,
      });
      if (slot.startTime === preferredClock) continue; // already clear, no update needed
      const endTime = addMinutesToClock(slot.startTime, durationMin);
      await sql`UPDATE tasks SET start_time = ${slot.startTime}, end_time = ${endTime}, updated_at = now() WHERE id = ${t.id}`;
    }
  }
}

// A plain ad-hoc task (added from the To-Do list, not tied to a goal/project/routine)
// had no equivalent to Plan Shift at all -- it just sat overdue forever once its day
// passed. Same lazy/idempotent pattern: called on every /api/user-projects load. Medium/
// High/Urgent move to the very next day (the normal "I didn't get to it, try again
// tomorrow" case); Low priority pushes out a few days at a time, since it explicitly
// isn't urgent and re-nagging about it daily isn't the point -- "later in the week."
// Goal-linked, routine-derived, and Project tasks are excluded since they already have
// their own real handling (applyPlanShiftForUser / materializeRoutinesForDate).
export async function rescheduleMissedSimpleTasks(sql, user, targetDate) {
  const overdue = await sql`
    SELECT id, priority FROM tasks
    WHERE user_id = ${user.id} AND status = 'Pending' AND due_date < ${targetDate}
      AND goal_id IS NULL AND parent_task_id IS NULL AND routine_id IS NULL AND kind != 'project'
  `;
  for (const t of overdue) {
    const daysToAdd = t.priority === 'Low' ? 3 : 1;
    await sql`UPDATE tasks SET due_date = due_date + (INTERVAL '1 day' * ${daysToAdd}), updated_at = now() WHERE id = ${t.id}`;
  }
}

// 2.9.1's Strict path deliberately doesn't auto-edit the plan the way Dynamic's Plan
// Shift does -- silently changing a fixed-deadline plan's frequency/difficulty is a real
// judgment call this project has no scheduled-job infra to run safely, and getting it
// wrong would be worse than not intensifying at all. Instead, a real in-app notification
// -- deduped to once per goal per day via deep_link_target's goalId -- surfaces that the
// user is behind, pointing them at Retake Assessment or manual adjustment.
export async function notifyStrictDeadlineRisk(sql, user, targetDate) {
  const atRiskGoals = await sql`
    SELECT DISTINCT g.id, g.title FROM goals g
    JOIN tasks t ON t.goal_id = g.id
    WHERE g.user_id = ${user.id} AND g.timeline_type = 'strict' AND g.is_active = true
      AND t.status = 'Pending' AND t.due_date < ${targetDate}
  `;
  for (const g of atRiskGoals) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM notifications
      WHERE user_id = ${user.id} AND deep_link_target->>'goalId' = ${String(g.id)} AND created_at::date = ${targetDate}
    `;
    if (count > 0) continue;
    await createNotification(sql, user.id, {
      iconType: 'reminder',
      message: `You're falling behind on your Strict deadline for "${g.title}" — consider retaking the assessment or adjusting your plan.`,
      deepLinkTarget: { page: 'pillar-roadmap', goalId: g.id },
    });
  }
}

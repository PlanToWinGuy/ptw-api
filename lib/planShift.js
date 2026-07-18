import { createNotification } from './notifications.js';
import { findOpenSlot, addMinutesToClock, addDays } from './scheduling.js';
import { logTaskReschedule } from './tasks.js';

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + 'T00:00:00') - new Date(fromStr + 'T00:00:00')) / 86400000);
}

// Dynamic Timeline's Plan Shift (2.9.2) -- lazy and idempotent, same pattern as
// materializeRoutinesForDate: called on every /api/user-projects load rather than a
// cron job (no scheduled-job infra exists in this project). For each Project whose goal
// is Dynamic and has at least one still-Pending sub-task that's overdue (due_date <
// targetDate), the entire remaining sequence of that project's pending sub-tasks shifts
// forward, and the goal's own end_date (Projected Completion Date) shifts by the same
// amount. Strict-timeline goals are untouched here -- see
// api/tasks/update-completion.js's Strict-deadline notification instead.
export async function applyPlanShiftForUser(sql, user, targetDate) {
  const overdueProjects = await sql`
    SELECT t.parent_task_id AS project_id, t.goal_id AS goal_id, MIN(t.due_date) AS earliest_due
    FROM tasks t
    JOIN goals g ON g.id = t.goal_id
    WHERE t.user_id = ${user.id} AND t.status = 'Pending' AND t.due_date < ${targetDate}
      AND t.parent_task_id IS NOT NULL AND g.timeline_type = 'dynamic' AND g.is_active = true
    GROUP BY t.parent_task_id, t.goal_id
  `;

  for (const row of overdueProjects) {
    if (!row.project_id) continue;
    // How many days behind is this project, really -- not a flat "+1 day per call".
    // This function runs on every /api/user-projects hit (which can fire many times in
    // one sitting as a user switches between Home/Daily/Weekly), not once nightly, so a
    // fixed +1 day bump used to re-fire and compound every single time it was called
    // while any sub-task remained overdue, silently drifting a project's tasks days
    // into the future within one real day. Shifting by the actual gap converges to
    // "no longer overdue" in a single call regardless of how many times it's invoked
    // today or how long the project was neglected.
    const earliestDueStr = row.earliest_due instanceof Date ? row.earliest_due.toISOString().split('T')[0] : String(row.earliest_due).split('T')[0];
    const shiftDays = Math.max(1, daysBetween(earliestDueStr, targetDate));
    // Snapshot before the bulk UPDATE below so each shifted sub-task's own move can be
    // logged (old due_date -> new due_date) once it's known -- the UPDATE itself is a
    // single set-based statement, not a per-row loop, for the same reason it always was.
    const beforeShift = await sql`
      SELECT id, name, pillar_id, due_date FROM tasks WHERE parent_task_id = ${row.project_id} AND status = 'Pending'
    `;
    await sql`
      UPDATE tasks SET due_date = due_date + (INTERVAL '1 day' * ${shiftDays}), updated_at = now()
      WHERE parent_task_id = ${row.project_id} AND status = 'Pending'
    `;
    if (row.goal_id) {
      await sql`UPDATE goals SET end_date = end_date + (INTERVAL '1 day' * ${shiftDays}) WHERE id = ${row.goal_id} AND end_date IS NOT NULL`;
    }
    for (const t of beforeShift) {
      const oldDueStr = t.due_date instanceof Date ? t.due_date.toISOString().split('T')[0] : String(t.due_date).split('T')[0];
      await logTaskReschedule(sql, {
        userId: user.id, taskId: t.id, taskName: t.name, pillarId: t.pillar_id,
        fromDate: oldDueStr, toDate: addDays(oldDueStr, shiftDays), reason: 'Plan Shift (behind schedule)',
      });
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
// passed. Same lazy pattern: called on every /api/user-projects load. Medium/High/
// Urgent land back on today, in a real open slot (the "should be ASAP" expectation for
// an unfinished high-priority task); Low priority jumps to a fixed 3 days out from
// today, since it explicitly isn't urgent. Both resolve directly against targetDate
// rather than a "+1/+3 days from wherever it currently sits" -- this function runs on
// every request, not once nightly, so an additive bump used to keep re-firing and
// compounding every time the endpoint was hit while the task was still overdue (a user
// switching between Home/Daily/Weekly a few times in one sitting could drift a task
// several days forward in minutes). Resolving straight to targetDate/targetDate+3
// converges in one call no matter how many times it's invoked today or how long the
// task was neglected. Goal-linked, routine-derived, and Project tasks are excluded
// since they already have their own real handling (applyPlanShiftForUser /
// materializeRoutinesForDate).
export async function rescheduleMissedSimpleTasks(sql, user, targetDate) {
  const overdue = await sql`
    SELECT id, name, pillar_id, priority, estimated_duration_minutes, due_date FROM tasks
    WHERE user_id = ${user.id} AND status = 'Pending' AND due_date < ${targetDate}
      AND goal_id IS NULL AND parent_task_id IS NULL AND routine_id IS NULL AND kind != 'project'
  `;
  for (const t of overdue) {
    const oldDueStr = t.due_date instanceof Date ? t.due_date.toISOString().split('T')[0] : String(t.due_date).split('T')[0];
    if (t.priority === 'Low') {
      const newDate = addDays(targetDate, 3);
      await sql`UPDATE tasks SET due_date = ${newDate}, updated_at = now() WHERE id = ${t.id}`;
      await logTaskReschedule(sql, { userId: user.id, taskId: t.id, taskName: t.name, pillarId: t.pillar_id, fromDate: oldDueStr, toDate: newDate, reason: 'Missed (low priority, auto-rescheduled)' });
      continue;
    }
    const durationMin = t.estimated_duration_minutes || 30;
    const slot = await findOpenSlot(sql, user.id, {
      earliestDate: targetDate, searchDays: 1, durationMinutes: durationMin, excludeTaskId: t.id,
    });
    const endTime = addMinutesToClock(slot.startTime, durationMin);
    await sql`UPDATE tasks SET due_date = ${slot.date}, start_time = ${slot.startTime}, end_time = ${endTime}, updated_at = now() WHERE id = ${t.id}`;
    await logTaskReschedule(sql, { userId: user.id, taskId: t.id, taskName: t.name, pillarId: t.pillar_id, fromDate: oldDueStr, toDate: slot.date, reason: 'Missed (auto-rescheduled)' });
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

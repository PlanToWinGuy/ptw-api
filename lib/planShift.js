import { createNotification } from './notifications.js';

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

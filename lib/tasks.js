// Shared task-completion logic, used by both api/tasks/update-completion.js (the
// checkmark/slider flow) and api/metrics.js (a pillar Hub logging action that's tied
// to a scheduled Logging Task, via task_id -- see schema.sql's metric_logs.task_id).

// Completes (or partially completes) a task and awards its XP. Returns null if the
// task doesn't belong to this user.
export async function completeTask(sql, user, taskId, completionPercentage = 100) {
  const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id}`;
  const task = rows[0];
  if (!task) return null;

  const pct = Number(completionPercentage) || 0;
  const status = pct >= 100 ? 'Completed' : 'Pending';
  const xp_gained = pct >= 100 ? Math.round((task.estimated_duration_minutes || 20) * 1.5) + 20 : 0;

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

  // Partial completion (< 100%): a deterministic stand-in for "flag the remainder for
  // the AI to reschedule" -- create a same-kind follow-up task for the leftover time,
  // due today, rather than silently losing the un-finished portion.
  let remainderTask = null;
  if (pct > 0 && pct < 100 && task.estimated_duration_minutes) {
    const remainingMinutes = Math.round(task.estimated_duration_minutes * (1 - pct / 100));
    if (remainingMinutes >= 5) {
      const remRows = await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, priority, due_date, estimated_duration_minutes)
        VALUES (${task.user_id}, ${task.goal_id}, ${task.pillar_id}, ${task.name + ' (continued)'}, ${task.kind}, ${task.priority}, ${task.due_date}, ${remainingMinutes})
        RETURNING *
      `;
      remainderTask = remRows[0];
    }
  }

  if (xp_gained > 0) {
    await sql`UPDATE users SET xp = xp + ${xp_gained} WHERE id = ${user.id}`;
  }

  return { task: updated[0], xp_gained, remainderTask };
}

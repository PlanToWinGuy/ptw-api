import { sql, pillarIdFromName } from './db.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Lazy materialization: rather than a real nightly cron (new infra this project
// doesn't have), a routine gets turned into a real Logging Task for a given date the
// first time anything asks for that date -- idempotent (checks routine_id+due_date
// first), so it's safe to call this on every /api/user-projects request.
export async function materializeRoutinesForDate(user, targetDate) {
  const weekday = WEEKDAY_NAMES[new Date(targetDate + 'T00:00:00').getDay()];
  // end_date IS NULL means indefinite (every user-created routine, and habit/mindset
  // goals' daily_anchor) -- a project-linked recurring action stops materializing once
  // targetDate passes it. Compared in SQL, not JS, since a DATE column comes back from
  // the driver as a native Date object rather than a plain string (see Pass 1's fix in
  // api/tasks/update-completion.js for the same footgun).
  const routines = await sql`
    SELECT * FROM routines
    WHERE user_id = ${user.id} AND is_active = true
      AND (end_date IS NULL OR end_date >= ${targetDate})
  `;

  for (const r of routines) {
    const days = r.schedule_days || [];
    if (days.length && !days.includes(weekday)) continue;

    const existing = await sql`SELECT id FROM tasks WHERE routine_id = ${r.id} AND due_date = ${targetDate}`;
    if (existing.length) continue;

    const steps = r.steps || [];
    const totalMin = steps.reduce((s, st) => s + (Number(st.durationMinutes) || 0), 0) || 15;
    const pillarId = pillarIdFromName(r.category);

    await sql`
      INSERT INTO tasks (user_id, goal_id, pillar_id, routine_id, name, kind, estimated_duration_minutes, due_date, start_time, priority, tool_hint)
      VALUES (${user.id}, ${r.goal_id || null}, ${pillarId}, ${r.id}, ${r.name}, 'habit', ${totalMin}, ${targetDate}, ${r.schedule_time}, 'Medium', ${r.tool_hint || null})
    `;
  }
}

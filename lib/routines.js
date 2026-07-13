import { sql, pillarIdFromName } from './db.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Lazy materialization: rather than a real nightly cron (new infra this project
// doesn't have), a routine gets turned into a real Logging Task for a given date the
// first time anything asks for that date -- idempotent (checks routine_id+due_date
// first), so it's safe to call this on every /api/user-projects request.
export async function materializeRoutinesForDate(user, targetDate) {
  const weekday = WEEKDAY_NAMES[new Date(targetDate + 'T00:00:00').getDay()];
  const routines = await sql`SELECT * FROM routines WHERE user_id = ${user.id} AND is_active = true`;

  for (const r of routines) {
    const days = r.schedule_days || [];
    if (days.length && !days.includes(weekday)) continue;

    const existing = await sql`SELECT id FROM tasks WHERE routine_id = ${r.id} AND due_date = ${targetDate}`;
    if (existing.length) continue;

    const steps = r.steps || [];
    const totalMin = steps.reduce((s, st) => s + (Number(st.durationMinutes) || 0), 0) || 15;
    const pillarId = pillarIdFromName(r.category);

    await sql`
      INSERT INTO tasks (user_id, pillar_id, routine_id, name, kind, estimated_duration_minutes, due_date, start_time, priority)
      VALUES (${user.id}, ${pillarId}, ${r.id}, ${r.name}, 'habit', ${totalMin}, ${targetDate}, ${r.schedule_time}, 'Medium')
    `;
  }
}

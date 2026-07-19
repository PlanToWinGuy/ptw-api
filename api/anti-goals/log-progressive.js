import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const FULL_XP = 20;
const PARTIAL_XP = 10;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { taskId, loggedValue } = req.body || {};
  if (!taskId || loggedValue === undefined || loggedValue === null) {
    return res.status(422).json({ message: 'taskId and loggedValue are required' });
  }

  const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id} AND is_anti_goal = true AND anti_goal_type = 'progressive'`;
  const task = rows[0];
  if (!task) return res.status(404).json({ message: 'Anti-Goal task not found' });

  const logged = Number(loggedValue);
  const target = Number(task.target_value);
  const baseline = Number(task.baseline_value);

  let feedbackMessage, xpGained;
  if (logged <= target) {
    feedbackMessage = `Great work! You hit your target of ${target} or lower today. 🎉`;
    xpGained = FULL_XP;
  } else if (logged < baseline) {
    feedbackMessage = `You logged ${logged} today. That is still ${(baseline - logged).toFixed(1).replace(/\.0$/, '')} fewer than your average. That is real progress and something to be proud of.`;
    xpGained = PARTIAL_XP;
  } else {
    feedbackMessage = "Okay, today was tough. That's part of the process. Tomorrow is a new day.";
    xpGained = 0;
  }

  await sql`UPDATE tasks SET status = 'Completed', xp_gained = ${xpGained}, updated_at = now() WHERE id = ${taskId}`;
  if (xpGained > 0) await sql`UPDATE users SET xp = xp + ${xpGained} WHERE id = ${user.id}`;

  // Step the next day's target down toward the final target -- a deterministic ramp,
  // not a live AI-computed schedule (baseline/final gap spread over ~2 weeks, floor 1/day).
  const finalTarget = Number(task.final_target_value ?? target);
  const step = Math.max(1, Math.round((baseline - finalTarget) / 14));
  const nextTarget = Math.max(finalTarget, target - step);

  // Carries the same start_time/end_time forward -- previously dropped entirely, so the
  // regenerated task landed with no scheduled slot (bucketed into "Unscheduled" instead
  // of its real end-of-day check-in time), easy to overlook and read as if the anti-goal
  // had silently stopped recurring.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  await sql`
    INSERT INTO tasks (user_id, pillar_id, quest_id, name, kind, recurrence, due_date, estimated_duration_minutes,
                        start_time, end_time, is_anti_goal, anti_goal_type, baseline_value, target_value, final_target_value)
    VALUES (${task.user_id}, ${task.pillar_id}, ${task.quest_id}, ${task.name}, 'habit', 'daily', ${tomorrow}, ${task.estimated_duration_minutes},
            ${task.start_time}, ${task.end_time}, true, 'progressive', ${task.baseline_value}, ${nextTarget}, ${task.final_target_value})
  `;

  res.status(200).json({ feedbackMessage, xpGained });
}

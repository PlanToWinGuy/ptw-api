import { sql, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { computeStreakDays } from '../../lib/tasks.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillarParam = req.query.pillar;
  const pillarId = pillarParam && pillarParam !== 'all' ? pillarIdFromName(pillarParam) : null;

  // `${pillarId}::int IS NULL OR pillar_id = ${pillarId}` -- one query works for both the
  // "all pillars" and "one pillar" cases without duplicating every statement.
  const today = new Date().toISOString().split('T')[0];
  const [{ completed, skipped, pending, late }] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'Skipped') AS skipped,
      COUNT(*) FILTER (WHERE status = 'Pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'Pending' AND due_date IS NOT NULL AND due_date < ${today}) AS late
    FROM tasks WHERE user_id = ${user.id} AND (${pillarId}::int IS NULL OR pillar_id = ${pillarId})
  `;
  const [{ avg_minutes }] = await sql`
    SELECT COALESCE(ROUND(AVG(estimated_duration_minutes)), 0) AS avg_minutes
    FROM tasks WHERE user_id = ${user.id} AND (${pillarId}::int IS NULL OR pillar_id = ${pillarId}) AND status = 'Completed'
  `;
  // Efficiency: of completed tasks, how many were finished on or before their due date --
  // a real "did you do it on time" measure, distinct from completion_rate ("did you do it
  // at all"). Same on-time concept already used in the Work pillar's analytics.
  const [{ on_time, off_time }] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE due_date IS NULL OR updated_at::date <= due_date) AS on_time,
      COUNT(*) FILTER (WHERE due_date IS NOT NULL AND updated_at::date > due_date) AS off_time
    FROM tasks WHERE user_id = ${user.id} AND (${pillarId}::int IS NULL OR pillar_id = ${pillarId}) AND status = 'Completed'
  `;

  const completedNum = Number(completed), skippedNum = Number(skipped), pendingNum = Number(pending);
  const totalForRate = completedNum + skippedNum + pendingNum;
  const completion_rate_percent = totalForRate ? Math.round((completedNum / totalForRate) * 100) : 0;
  const efficiencyTotal = Number(on_time) + Number(off_time);
  const efficiency_percent = efficiencyTotal ? Math.round((Number(on_time) / efficiencyTotal) * 100) : 0;

  const daily_streak = await computeStreakDays(sql, user); // overall app streak -- doesn't change per pillar

  res.status(200).json({
    total_tasks_completed: completedNum,
    late_tasks: Number(late),
    avg_time_per_task_minutes: Number(avg_minutes),
    efficiency_percent,
    daily_streak,
    completion_rate_percent,
    skipped_tasks: skippedNum,
  });
}

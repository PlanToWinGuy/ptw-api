import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { completeTask } from '../../lib/tasks.js';

// Consolidated task-instance actions -- one serverless function, dispatched by
// ?action=, same pattern as api/metrics.js?action=scan-meal. Default (no action) is
// the original "complete/partially-complete a task" flow.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const action = req.query.action;

  if (action === 'skip') {
    const { task_id } = req.body || {};
    if (!task_id) return res.status(422).json({ message: 'task_id is required' });
    await sql`UPDATE tasks SET status = 'Skipped', updated_at = now() WHERE id = ${task_id} AND user_id = ${user.id}`;
    return res.status(200).json({ message: 'Task skipped and will be rescheduled.' });
  }

  if (action === 'add-time') {
    const { task_id, minutes_to_add } = req.body || {};
    if (!task_id) return res.status(422).json({ message: 'task_id is required' });
    const mins = Number(minutes_to_add) || 10;
    const rows = await sql`SELECT * FROM tasks WHERE id = ${task_id} AND user_id = ${user.id}`;
    const task = rows[0];
    if (!task) return res.status(404).json({ message: 'Task not found' });

    await sql`
      UPDATE tasks SET end_time = COALESCE(end_time, start_time) + (${mins} || ' minutes')::interval
      WHERE id = ${task_id} AND user_id = ${user.id}
    `;
    // Simple Shift: push every later task on the same day forward by the same amount.
    if (task.due_date && task.start_time) {
      await sql`
        UPDATE tasks SET
          start_time = start_time + (${mins} || ' minutes')::interval,
          end_time = end_time + (${mins} || ' minutes')::interval
        WHERE user_id = ${user.id} AND due_date = ${task.due_date}
          AND id != ${task_id} AND start_time > ${task.start_time}
      `;
    }
    return res.status(200).json({ message: `${mins} minutes added and schedule shifted successfully.` });
  }

  if (action === 'reschedule') {
    const { task_id, new_date, new_start_time } = req.body || {};
    if (!task_id) return res.status(422).json({ message: 'task_id is required' });
    await sql`
      UPDATE tasks SET
        due_date = COALESCE(${new_date || null}, due_date),
        start_time = ${new_start_time || null},
        end_time = NULL,
        updated_at = now()
      WHERE id = ${task_id} AND user_id = ${user.id}
    `;
    return res.status(200).json({ message: 'Task successfully rescheduled.' });
  }

  if (action === 'shuffle-day') {
    const { date, commit } = req.body || {};
    const targetDate = date || new Date().toISOString().split('T')[0];
    const rows = await sql`
      SELECT * FROM tasks WHERE user_id = ${user.id} AND due_date = ${targetDate} AND status = 'Pending'
      ORDER BY CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, start_time NULLS LAST, created_at ASC
    `;
    const isToday = targetDate === new Date().toISOString().split('T')[0];
    let cursor = isToday ? new Date() : new Date(targetDate + 'T08:00:00');
    if (!isToday) cursor.setHours(8, 0, 0, 0);

    const tasksDeferred = [];
    const proposed = [];
    for (const t of rows) {
      const durationMin = t.estimated_duration_minutes || 30;
      const startStr = cursor.toTimeString().slice(0, 8);
      cursor = new Date(cursor.getTime() + durationMin * 60000);
      if (cursor.getHours() >= 23 && cursor.getMinutes() > 0) {
        tasksDeferred.push(t.name);
        continue;
      }
      const endStr = cursor.toTimeString().slice(0, 8);
      proposed.push({ ...t, start_time: startStr, end_time: endStr });
    }

    if (commit) {
      for (const t of proposed) {
        await sql`UPDATE tasks SET start_time = ${t.start_time}, end_time = ${t.end_time} WHERE id = ${t.id} AND user_id = ${user.id}`;
      }
    }

    return res.status(200).json({
      proposal_summary: {
        tasks_deferred: tasksDeferred,
        streak_protection_note: proposed.length ? 'Your highest-priority tasks were kept in place.' : 'Nothing to shuffle today.',
      },
      proposed_schedule: proposed.map(t => ({ taskId: t.id, name: t.name, startTime: t.start_time, endTime: t.end_time })),
      committed: !!commit,
    });
  }

  // Default: complete or partially-complete a task (the original behavior).
  const { task_id, completion_percentage } = req.body || {};
  if (!task_id) return res.status(422).json({ message: 'task_id is required' });

  const result = await completeTask(sql, user, task_id, completion_percentage);
  if (!result) return res.status(404).json({ message: 'Task not found' });

  const userRows = await sql`SELECT xp FROM users WHERE id = ${user.id}`;
  res.status(200).json({
    data: {
      xp_gained: result.xp_gained,
      new_total_xp: userRows[0].xp,
      task: result.task.name,
      remainder_task: result.remainderTask ? { id: result.remainderTask.id, name: result.remainderTask.name } : null,
    },
  });
}

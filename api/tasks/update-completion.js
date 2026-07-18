import { sql } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { completeTask, logTaskReschedule } from '../../lib/tasks.js';
import { materializeRoutinesForDate } from '../../lib/routines.js';

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
    // Real daily task bank (Pass 1): a skip no longer just hides the task by marking it
    // 'Skipped' forever -- the first skip bumps it to an end-of-day bank slot on the same
    // date (still visible, still completable). Skipping it again from that bank slot rolls
    // it to tomorrow instead of bumping it later and later forever. This is a lightweight
    // two-tier rule, not the full AI-driven Plan Shift recalibration (2.9), which is a
    // separate, deferred system.
    const { task_id } = req.body || {};
    if (!task_id) return res.status(422).json({ message: 'task_id is required' });
    const rows = await sql`SELECT * FROM tasks WHERE id = ${task_id} AND user_id = ${user.id}`;
    const task = rows[0];
    if (!task) return res.status(404).json({ message: 'Task not found' });
    const today = new Date().toISOString().split('T')[0];
    // The neon driver returns a DATE column as a native JS Date object, not a string --
    // normalize before doing any string work on it (unlike TIME columns, which already
    // come back as plain "HH:MM:SS" strings).
    const dueDateStr = task.due_date ? (task.due_date instanceof Date ? task.due_date.toISOString().split('T')[0] : String(task.due_date).split('T')[0]) : null;

    if (task.was_skipped) {
      const anchorDate = dueDateStr || today;
      const tomorrow = new Date(anchorDate + 'T00:00:00');
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      await sql`
        UPDATE tasks SET due_date = ${tomorrowStr}, start_time = NULL, end_time = NULL, was_skipped = false, updated_at = now()
        WHERE id = ${task_id} AND user_id = ${user.id}
      `;
      await logTaskReschedule(sql, { userId: user.id, taskId: task.id, taskName: task.name, pillarId: task.pillar_id, fromDate: anchorDate, toDate: tomorrowStr, reason: 'Skipped a second time' });
      return res.status(200).json({ message: 'Task moved to tomorrow.' });
    }

    const dueDate = dueDateStr || today;
    const BANK_START = '20:00:00';
    let bankStart = BANK_START;
    const [{ latest_end }] = await sql`
      SELECT MAX(end_time) AS latest_end FROM tasks
      WHERE user_id = ${user.id} AND due_date = ${dueDate} AND id != ${task_id} AND end_time IS NOT NULL
    `;
    if (latest_end && String(latest_end) > BANK_START) bankStart = String(latest_end);
    const durationMin = task.estimated_duration_minutes || 20;
    await sql`
      UPDATE tasks SET
        due_date = ${dueDate},
        start_time = ${bankStart}::time,
        end_time = (${bankStart}::time + (${durationMin} || ' minutes')::interval),
        was_skipped = true,
        updated_at = now()
      WHERE id = ${task_id} AND user_id = ${user.id}
    `;
    return res.status(200).json({ message: 'Task moved to later today.' });
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
    const beforeRows = await sql`SELECT name, pillar_id, due_date FROM tasks WHERE id = ${task_id} AND user_id = ${user.id}`;
    const before = beforeRows[0];
    await sql`
      UPDATE tasks SET
        due_date = COALESCE(${new_date || null}, due_date),
        start_time = ${new_start_time || null},
        end_time = NULL,
        updated_at = now()
      WHERE id = ${task_id} AND user_id = ${user.id}
    `;
    if (before && new_date) {
      const oldDueStr = before.due_date ? (before.due_date instanceof Date ? before.due_date.toISOString().split('T')[0] : String(before.due_date).split('T')[0]) : null;
      await logTaskReschedule(sql, { userId: user.id, taskId: task_id, taskName: before.name, pillarId: before.pillar_id, fromDate: oldDueStr, toDate: new_date, reason: 'Manually rescheduled' });
    }
    return res.status(200).json({ message: 'Task successfully rescheduled.' });
  }

  if (action === 'shuffle-day') {
    const { date, context, new_start_time } = req.body || {};
    const targetDate = date || new Date().toISOString().split('T')[0];
    const isToday = targetDate === new Date().toISOString().split('T')[0];
    let rows = await sql`
      SELECT * FROM tasks WHERE user_id = ${user.id} AND due_date = ${targetDate} AND status = 'Pending'
      ORDER BY CASE priority WHEN 'Urgent' THEN -1 WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, start_time NULLS LAST, created_at ASC
    `;

    const tasksShortened = [];
    const tasksDeferred = [];
    const deferredIds = []; // captured at the moment of deferral -- `rows` gets reassigned
                             // right after in some branches, so this can't be reconstructed later
    let streakNote = 'Your highest-priority tasks were kept in place.';
    let startDelayMinutes = 0;
    let anchorClock = null; // "Slept in" only: re-anchor the whole day to this HH:MM

    // Real, deterministic per-context rules (no AI call -- these are simple enough to
    // be honest rules rather than something worth spending on a live model for).
    if (context === 'Low energy / Mental off-day') {
      const lowPri = rows.filter(t => t.priority === 'Low');
      lowPri.forEach(t => { tasksDeferred.push(t.name); deferredIds.push(t.id); });
      rows = rows.filter(t => t.priority !== 'Low').map(t => {
        if (t.estimated_duration_minutes) {
          const shortened = Math.max(5, Math.round(t.estimated_duration_minutes * 0.67));
          if (shortened < t.estimated_duration_minutes) {
            tasksShortened.push(`'${t.name}' is now ${shortened} mins`);
            return { ...t, estimated_duration_minutes: shortened };
          }
        }
        return t;
      });
      streakNote = 'Your core habits are still on track today.';
    } else if (context === 'Hungover or sick') {
      const coreHabit = rows.find(t => t.kind === 'habit');
      rows.filter(t => t !== coreHabit).forEach(t => { tasksDeferred.push(t.name); deferredIds.push(t.id); });
      rows = coreHabit ? [coreHabit] : [];
      streakNote = coreHabit ? `Your '${coreHabit.name}' streak is safe because you selected "Sick" as your reason.` : 'Nothing mandatory today -- rest up.';
    } else if (context === 'Social surprise / Change of plans') {
      rows.filter(t => t.priority !== 'High' && t.priority !== 'Urgent').forEach(t => { tasksDeferred.push(t.name); deferredIds.push(t.id); });
      rows = rows.filter(t => t.priority === 'High' || t.priority === 'Urgent');
      streakNote = 'High-priority tasks were protected around your change of plans.';
    } else if (context === 'Travel / Errands took longer') {
      startDelayMinutes = 60; // assume an hour of today's window is already gone
      streakNote = 'Your schedule was compressed to fit the remaining time today.';
    } else if (context === 'Slept in / Starting late') {
      // The whole day slides to start from the new wake-up time (or now) -- nothing is
      // dropped by priority, everything just moves later in its existing order. The repack
      // loop below still defers anything that no longer fits before the end of the day.
      anchorClock = /^\d{2}:\d{2}$/.test(new_start_time || '') ? new_start_time : null;
      streakNote = 'Your whole day was shifted to start from your new wake-up time — nothing was dropped, just moved later.';
    } else if (context === "Feeling productive! Let's optimize") {
      // parent_task_id IS NULL excludes Project sub-tasks -- those are never independently
      // scheduled, so they must never get pulled into today's list as if they were backlog.
      const backlog = await sql`SELECT * FROM tasks WHERE user_id = ${user.id} AND status = 'Pending' AND due_date IS NULL AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 5`;
      rows = [...rows, ...backlog];
      streakNote = 'Pulled a few backlog tasks in since you have the energy for it.';
    }

    let cursor = isToday ? new Date() : new Date(targetDate + 'T08:00:00');
    if (!isToday) cursor.setHours(8, 0, 0, 0);
    // "Slept in": anchor to the chosen new wake time, but never earlier than the real
    // current moment when it's today (you can't schedule into the past).
    if (anchorClock) {
      const [h, m] = anchorClock.split(':').map(Number);
      const anchored = new Date(targetDate + 'T00:00:00');
      anchored.setHours(h, m, 0, 0);
      cursor = (isToday && anchored < new Date()) ? new Date() : anchored;
    }
    if (startDelayMinutes) cursor = new Date(cursor.getTime() + startDelayMinutes * 60000);

    const proposed = [];
    for (const t of rows) {
      const durationMin = t.estimated_duration_minutes || 30;
      const startStr = cursor.toTimeString().slice(0, 8);
      cursor = new Date(cursor.getTime() + durationMin * 60000);
      if (cursor.getHours() >= 23 && cursor.getMinutes() > 0) {
        tasksDeferred.push(t.name);
        deferredIds.push(t.id);
        continue;
      }
      const endStr = cursor.toTimeString().slice(0, 8);
      proposed.push({ ...t, start_time: startStr, end_time: endStr, estimated_duration_minutes: durationMin });
    }

    return res.status(200).json({
      proposal_summary: {
        tasks_deferred: tasksDeferred,
        tasks_shortened: tasksShortened,
        streak_protection_note: streakNote,
      },
      proposed_schedule: proposed.map(t => ({ taskId: t.id, name: t.name, startTime: t.start_time, endTime: t.end_time, estimatedDurationMinutes: t.estimated_duration_minutes })),
      _deferredIds: deferredIds, // internal, used by confirm-shuffle
    });
  }

  if (action === 'confirm-shuffle') {
    const { date, new_schedule, deferred_ids } = req.body || {};
    if (!Array.isArray(new_schedule)) return res.status(422).json({ message: 'new_schedule is required' });
    for (const t of new_schedule) {
      await sql`
        UPDATE tasks SET start_time = ${t.startTime}, end_time = ${t.endTime},
          estimated_duration_minutes = COALESCE(${t.estimatedDurationMinutes || null}, estimated_duration_minutes)
        WHERE id = ${t.taskId} AND user_id = ${user.id}
      `;
    }
    if (Array.isArray(deferred_ids) && deferred_ids.length) {
      const deferredRows = await sql`SELECT id, name, pillar_id FROM tasks WHERE id = ANY(${deferred_ids}) AND user_id = ${user.id}`;
      await sql`UPDATE tasks SET due_date = NULL, start_time = NULL, end_time = NULL WHERE id = ANY(${deferred_ids}) AND user_id = ${user.id}`;
      for (const t of deferredRows) {
        await logTaskReschedule(sql, { userId: user.id, taskId: t.id, taskName: t.name, pillarId: t.pillar_id, fromDate: date, toDate: null, reason: 'Shuffle Day (deferred to backlog)' });
      }
    }
    return res.status(200).json({ message: 'Your schedule for the day has been successfully updated.' });
  }

  if (action === 'generate-for-tomorrow') {
    // MVP slice of the "Nightly Plan": eagerly materialize tomorrow's routines now
    // instead of waiting for lazy materialization on next load, so the Wind-Down
    // preview and tomorrow's Home page are already populated.
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    await materializeRoutinesForDate(user, tomorrow);
    return res.status(200).json({ message: 'Schedule for tomorrow has been successfully generated.' });
  }

  // Default: complete or partially-complete a task (the original behavior).
  const { task_id, completion_percentage, actual_minutes_spent } = req.body || {};
  if (!task_id) return res.status(422).json({ message: 'task_id is required' });

  const result = await completeTask(sql, user, task_id, completion_percentage, actual_minutes_spent);
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

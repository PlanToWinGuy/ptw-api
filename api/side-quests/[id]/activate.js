import { sql, PILLARS } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';
import { timeOfDayToClock, addMinutesToClock, inferToolHint, scheduleSubTasks } from '../../../lib/scheduling.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const rows = await sql`SELECT * FROM side_quests WHERE id = ${id} AND user_id = ${user.id} AND status = 'draft'`;
  const draft = rows[0];
  if (!draft) return res.status(404).json({ message: 'Draft quest not found' });

  const plan = draft.draft_data;
  const today = new Date().toISOString().split('T')[0];
  const isAntiGoal = !!plan.antiGoalType;
  const pillarKey = (PILLARS[draft.pillar_id] || '').toLowerCase();

  // A custom quest doesn't have its own questionnaire, so borrow the user's most recent
  // time-of-day/daily-budget answers for this pillar (if they've ever activated it) --
  // same scheduling approach as api/goals.js, falling back to sensible defaults.
  const [priorAnswers] = await sql`SELECT answers FROM pillar_answers WHERE user_id = ${user.id} AND pillar_id = ${draft.pillar_id} ORDER BY created_at DESC LIMIT 1`;
  const clockStart = timeOfDayToClock(priorAnswers?.answers?.time_of_day);
  const dailyBudgetMinutes = Number(priorAnswers?.answers?.daily_time_budget) || 60;

  let projectsOut = [];
  if (isAntiGoal) {
    // Day 1's target starts at the baseline itself (just match your current average)
    // and steps down daily toward final_target_value -- see log-progressive.js.
    const dayOneTarget = plan.antiGoalType === 'progressive' ? (plan.baselineValue ?? null) : null;
    const startTime = clockStart;
    const endTime = addMinutesToClock(clockStart, 15);
    const toolHint = inferToolHint(pillarKey, plan.title);
    await sql`
      INSERT INTO tasks (user_id, pillar_id, quest_id, name, kind, recurrence, due_date, estimated_duration_minutes,
                          start_time, end_time, tool_hint,
                          is_anti_goal, anti_goal_type, baseline_value, target_value, final_target_value)
      VALUES (${user.id}, ${draft.pillar_id}, ${id}, ${plan.title}, 'habit', 'daily', ${today}, 15,
              ${startTime}, ${endTime}, ${toolHint},
              true, ${plan.antiGoalType}, ${plan.baselineValue ?? null}, ${dayOneTarget}, ${plan.targetValue ?? null})
    `;
  } else {
    const projects = plan.projects || [];
    for (const p of projects) {
      const subTasks = p.subTasks || [];
      const parentRows = await sql`
        INSERT INTO tasks (user_id, pillar_id, quest_id, name, kind, due_date, estimated_duration_minutes)
        VALUES (${user.id}, ${draft.pillar_id}, ${id}, ${p.projectName}, 'project', ${today}, ${subTasks.length * 30})
        RETURNING id
      `;
      const parent_task_id = parentRows[0].id;
      const scheduled = scheduleSubTasks(subTasks.map(st => ({ text: st.name })), { startDate: today, clockStart, dailyBudgetMinutes, subtaskMinutes: 30 });
      const subTaskRows = [];
      for (const st of scheduled) {
        const toolHint = inferToolHint(pillarKey, st.text);
        const r = await sql`
          INSERT INTO tasks (user_id, pillar_id, quest_id, parent_task_id, name, kind, due_date, estimated_duration_minutes, start_time, end_time, tool_hint)
          VALUES (${user.id}, ${draft.pillar_id}, ${id}, ${parent_task_id}, ${st.text}, 'simple', ${st.dueDate}, 30, ${st.startTime}, ${st.endTime}, ${toolHint})
          RETURNING id, name
        `;
        subTaskRows.push({ subTaskId: r[0].id, name: r[0].name, isCompleted: false });
      }
      projectsOut.push({ projectId: parent_task_id, projectName: p.projectName, projectProgressPercent: 0, subTasks: subTaskRows });
    }
  }

  const updated = await sql`
    UPDATE side_quests SET
      is_active = true, status = 'active', suggestion = ${plan.title}, ai_strategy = ${plan.aiStrategy || null},
      xp = ${plan.rewards?.xp || 100}, badge_name = ${plan.rewards?.badgeName || null}, end_date = ${plan.endDate || null},
      is_anti_goal = ${isAntiGoal}, draft_data = NULL
    WHERE id = ${id}
    RETURNING *
  `;
  const quest = updated[0];

  res.status(201).json({
    message: 'Side Quest activated successfully!',
    quest: {
      questId: quest.id,
      title: quest.suggestion,
      status: 'active',
      aiStrategy: quest.ai_strategy,
      rewards: { xp: quest.xp, badgeName: quest.badge_name },
      endDate: quest.end_date,
      pillar: PILLARS[quest.pillar_id] || null,
      isAntiGoal,
      projects: projectsOut,
    },
  });
}

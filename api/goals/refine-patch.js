import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { timeOfDayToClock, addDays, inferToolHint, isRecurringAction } from '../../lib/scheduling.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// A small, targeted edit to an EXISTING goal -- distinct from api/goals.js's full
// generateGoal(), which supersedes the whole plan (deletes pending tasks, deactivates
// routines, starts over). Real feedback: someone who wants to drop push-ups for elbow
// sensitivity shouldn't have to regenerate their entire 90-day plan to do it. This asks
// the AI for a minimal diff against the CURRENT plan, not a new plan from scratch.
const SYSTEM = `You make a small, targeted edit to someone's existing goal plan based on their specific request. You are NOT creating a new plan -- only change what they actually asked about, leave everything else untouched. Return ONLY JSON:
{
  "summary": "<1 sentence, second person, what you changed and why>",
  "removeActions": ["<exact text of an existing phase action to remove, copied verbatim from the plan below>"],
  "addActions": [{"text": "<new action, same style/specificity as the existing plan>", "phaseLabel": "<an existing phase label to add it under, or null for a new 'Refinements' phase>"}],
  "removeTips": ["<exact text of an existing tip to remove, copied verbatim from the tips list below>"],
  "addTips": ["<new tip text>"],
  "dailyAnchorReplacement": "<new daily anchor text>" or null if the daily anchor isn't what they're asking to change
}
removeActions/removeTips must be copied EXACTLY (verbatim) from the lists provided, or removal will silently fail to match. Keep changes minimal -- if they want to remove one exercise, only touch that one action, don't restructure the whole plan.
addActions must ONLY be concrete, schedulable things that belong on a calendar at a specific time. If their request is really a general awareness rule, if-then habit reminder, or situational heads-up (e.g. "remind me to log purchases over $20 before I leave the store") rather than something to schedule, put it in addTips instead -- never in addActions. If their request doesn't map to anything actionable or tip-worthy, return everything empty and explain why in summary.`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { goal_id, request: refinementRequest } = req.body || {};
  if (!goal_id || !refinementRequest) {
    return res.status(422).json({ message: 'Validation failed', errors: { request: ['goal_id and request are required.'] } });
  }

  const goalRows = await sql`SELECT * FROM goals WHERE id = ${goal_id} AND user_id = ${user.id} AND is_active = true`;
  const goal = goalRows[0];
  if (!goal) return res.status(404).json({ message: 'Goal not found' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ message: 'ANTHROPIC_API_KEY not set on the server' });

  const allActionTexts = (goal.phases || []).flatMap(ph => (ph.actions || []));

  let parsed;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        temperature: 0.3,
        system: SYSTEM,
        messages: [{ role: 'user', content: [
          `Goal: ${goal.title}`,
          `Daily anchor: ${goal.daily_anchor || '(none)'}`,
          `Current phase actions:\n${(goal.phases || []).map(ph => `[${ph.label}]\n` + (ph.actions || []).map(a => `- ${a}`).join('\n')).join('\n')}`,
          allActionTexts.length ? '' : '(this goal has no discrete phase actions to edit -- only the daily anchor, if relevant)',
          `Current tips:\n${(goal.tips || []).map(t => `- ${t}`).join('\n') || '(none yet)'}`,
          `Their refinement request: "${refinementRequest}"`,
        ].filter(Boolean).join('\n') }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
  } catch (e) {
    console.error('goals.refine-patch: AI call failed', { goal_id, user_id: user.id, error: String(e) });
    return res.status(500).json({ message: "Couldn't process that refinement -- try again." });
  }

  const removeActions = Array.isArray(parsed.removeActions) ? parsed.removeActions : [];
  const removeTips = Array.isArray(parsed.removeTips) ? parsed.removeTips : [];
  // Same deterministic backstop as api/goals.js's original plan generation -- the
  // SYSTEM prompt above already asks for tip-phrased requests to go in addTips, but
  // that's prompt-only guidance with no code-level enforcement, so a tip-phrased
  // addAction can still slip through here too.
  const TIP_PHRASING_PATTERN = /\b(try |consider )?introduc(e|ing) (a |one |an )?(new|small|extra|optional)\b|\bwhen you can\b|\bif you (can|have time)\b|\bkeep in mind\b|\bconsider\b/i;
  const rawAddActions = Array.isArray(parsed.addActions) ? parsed.addActions : [];
  const addActions = rawAddActions.filter(a => !TIP_PHRASING_PATTERN.test(a?.text || ''));
  const addTips = [
    ...(Array.isArray(parsed.addTips) ? parsed.addTips.filter(t => typeof t === 'string' && t.trim()) : []),
    ...rawAddActions.filter(a => TIP_PHRASING_PATTERN.test(a?.text || '')).map(a => a.text),
  ];
  const dailyAnchorReplacement = typeof parsed.dailyAnchorReplacement === 'string' && parsed.dailyAnchorReplacement.trim() ? parsed.dailyAnchorReplacement.trim() : null;

  const pillarKey = (PILLARS[goal.pillar_id] || '').toLowerCase();
  const today = new Date().toISOString().split('T')[0];

  // Removals: pending one-off sub-tasks under this goal, or active routines under this
  // goal, matched by exact text -- a Completed task is never touched (past XP/history
  // stays real regardless of a later plan edit).
  let removedCount = 0;
  for (const actionText of removeActions) {
    const removedTasks = await sql`
      UPDATE tasks SET status = 'Skipped' WHERE goal_id = ${goal_id} AND parent_task_id IS NOT NULL AND status = 'Pending' AND name = ${actionText}
      RETURNING id
    `;
    const removedRoutines = await sql`
      UPDATE routines SET is_active = false WHERE goal_id = ${goal_id} AND is_active = true AND name = ${actionText}
      RETURNING id
    `;
    removedCount += removedTasks.length + removedRoutines.length;
  }

  // Additions: schedule directly (tomorrow, or the goal's own clockStart if it can be
  // inferred) rather than re-running the full bin-packing scheduler for one new action --
  // this is a small patch, not a regeneration.
  const clockStart = timeOfDayToClock(null);
  let addedCount = 0;
  for (const action of addActions) {
    if (!action?.text) continue;
    if (isRecurringAction(action.text)) {
      const toolHint = inferToolHint(pillarKey, action.text);
      // end_date NULL -> indefinite habit (matches api/goals.js) so a recurring action
      // doesn't silently stop appearing on Daily Overview when the goal timeline passes.
      await sql`
        INSERT INTO routines (user_id, goal_id, name, category, is_active, schedule_days, schedule_time, steps, tool_hint, end_date)
        VALUES (${user.id}, ${goal_id}, ${action.text}, ${PILLARS[goal.pillar_id]}, true, ${[]}, ${clockStart}::time,
                ${JSON.stringify([{ name: action.text, durationMinutes: 30 }])}::jsonb, ${toolHint}, NULL)
      `;
    } else {
      const parentRows = await sql`SELECT id FROM tasks WHERE goal_id = ${goal_id} AND kind = 'project' LIMIT 1`;
      const parentTaskId = parentRows[0]?.id || null;
      const toolHint = inferToolHint(pillarKey, action.text);
      const dueDate = addDays(today, 1);
      await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, parent_task_id, name, kind, phase_label, due_date, estimated_duration_minutes, start_time, tool_hint)
        VALUES (${user.id}, ${goal_id}, ${goal.pillar_id}, ${parentTaskId}, ${action.text}, 'simple', ${action.phaseLabel || null}, ${dueDate}, 30, ${clockStart}::time, ${toolHint})
      `;
    }
    addedCount++;
  }

  // Daily anchor swap: deactivate the old routine, create a fresh one under the new text.
  if (dailyAnchorReplacement && dailyAnchorReplacement !== goal.daily_anchor) {
    await sql`UPDATE routines SET is_active = false WHERE goal_id = ${goal_id} AND is_active = true AND name = ${goal.daily_anchor}`;
    const toolHint = inferToolHint(pillarKey, dailyAnchorReplacement);
    await sql`
      INSERT INTO routines (user_id, goal_id, name, category, is_active, schedule_days, schedule_time, steps, tool_hint, end_date)
      VALUES (${user.id}, ${goal_id}, ${dailyAnchorReplacement}, ${PILLARS[goal.pillar_id]}, true, ${[]}, ${clockStart}::time,
              ${JSON.stringify([{ name: dailyAnchorReplacement, durationMinutes: 15 }])}::jsonb, ${toolHint}, NULL)
    `;
  }

  // Keep goals.phases (what the Roadmap actually displays) in sync with the real edit --
  // remove matched action strings from whichever phase held them, append new ones under
  // their named phase (or a catch-all "Refinements" phase, created if this is the first).
  let phases = JSON.parse(JSON.stringify(goal.phases || []));
  if (removeActions.length) {
    phases = phases.map(ph => ({ ...ph, actions: (ph.actions || []).filter(a => !removeActions.includes(a)) }));
  }
  for (const action of addActions) {
    if (!action?.text) continue;
    let targetPhase = action.phaseLabel && phases.find(ph => ph.label === action.phaseLabel);
    if (!targetPhase) {
      targetPhase = phases.find(ph => ph.label === 'Refinements');
      if (!targetPhase) { targetPhase = { label: 'Refinements', duration: '', focus: 'Adjustments from your feedback', actions: [] }; phases.push(targetPhase); }
    }
    targetPhase.actions = [...(targetPhase.actions || []), action.text];
  }

  // Tips get the same real edit treatment as phase actions -- just against goals.tips
  // instead of goals.phases, and with no tasks/routines to touch since a tip was never
  // scheduled in the first place.
  let tips = [...(goal.tips || [])];
  if (removeTips.length) tips = tips.filter(t => !removeTips.includes(t));
  tips.push(...addTips);

  await sql`
    UPDATE goals SET phases = ${JSON.stringify(phases)}::jsonb, daily_anchor = ${dailyAnchorReplacement || goal.daily_anchor}, tips = ${JSON.stringify(tips)}::jsonb
    WHERE id = ${goal_id}
  `;

  res.status(200).json({
    summary: parsed.summary || 'Updated your plan.',
    removedCount,
    addedCount,
    addedTipsCount: addTips.length,
    removedTipsCount: removeTips.length,
    dailyAnchorChanged: !!dailyAnchorReplacement,
  });
}

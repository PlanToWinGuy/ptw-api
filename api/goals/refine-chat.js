import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { addDays, parseTimelineDays } from '../../lib/scheduling.js';
import { SYSTEM, PILLAR_PRINCIPLES, moveTipPhrasedActionsToTips, valueprintContext, profileContext, applyPlanToTasksAndRoutines } from '../goals.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Real back-and-forth refinement of a DRAFT plan (Review Blueprint, before the user has
// hit Accept) -- distinct from api/goals/refine-patch.js, which is a single-shot patch
// to an already-ACTIVE goal reached from the Roadmap's "Refine This Goal" button. This
// is the chat-based iteration the product owner asked for: "I want to open up to a chat
// page... talk and discuss higher quality plans... type and talk to it, then approve the
// final plan." The AI stays grounded in the exact same SYSTEM/PILLAR_PRINCIPLES prompt
// api/goals.js's real generation call uses (imported, not copied) so a refinement can't
// drift into generic unconstrained advice the fast-path plan never would have given.
const REFINE_MODE_ADDENDUM = `You are now in a back-and-forth REFINEMENT conversation about a plan you already drafted for this person, before they've committed to it. They can push back, ask questions, or ask for specific changes -- respond like a real coach talking it through with them, not a generic chatbot.
Every turn you MUST call the update_refined_plan tool. Always return the plan's ENTIRE current state in "plan" (every field), not a partial diff -- copy through any field you are not changing exactly as given below. Only change what they actually asked about or what "reply" explains you're changing; never restructure unrelated parts of the plan on your own initiative.
Stay grounded in the same plan-structuring rules above (timeline logic, the actions-vs-tips split, dailyAnchor rules, the pillar's own principles) for any change you make -- a refinement is still a real goal plan, not freeform advice.
If their message is a question or comment that doesn't actually require a plan change (e.g. "why mornings?"), set planChanged to false and return the plan completely unchanged -- never invent a change just to have something to show.
If they ask for something outside what a goal plan controls (e.g. medical/legal/financial advice beyond this app's own guidance), answer briefly and honestly in "reply" but leave the plan unchanged.`;

const REFINE_TOOL = {
  name: 'update_refined_plan',
  description: "Reply to the user's refinement message and return the plan's full current state (changed by this turn, or copied through unchanged).",
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Conversational, second-person reply, 1-4 sentences: explain what you changed and why, answer their question, or ask a clarifying question.' },
      planChanged: { type: 'boolean', description: 'true only if "plan" differs from what was given to you this turn.' },
      plan: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          timeline: { type: 'string' },
          why: { type: 'string' },
          phases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }, duration: { type: 'string' }, focus: { type: 'string' },
                actions: { type: 'array', items: { type: 'string' } },
              },
              required: ['label', 'actions'],
            },
          },
          dailyAnchor: { type: 'string' },
          milestones: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, marker: { type: 'string' } }, required: ['label', 'marker'] },
          },
          alts: { type: 'array', items: { type: 'string' } },
          tips: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'timeline', 'why', 'phases', 'dailyAnchor', 'milestones', 'alts', 'tips'],
      },
    },
    required: ['reply', 'planChanged', 'plan'],
  },
};

async function loadQuestionnaireAnswers(userId, pillarId) {
  const rows = await sql`SELECT answers FROM pillar_answers WHERE user_id = ${userId} AND pillar_id = ${pillarId} ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.answers || null;
}

// One turn of the refinement conversation: no DB writes here (the goal's real tasks/
// routines only get resynced once the user actually approves -- see finalizePlan below).
// The plan lives on the FRONTEND between turns (S.refineChatPlan) and is sent back each
// call as `current_plan` -- this keeps every turn a clean, idempotent request/response
// instead of a stateful draft the server has to track and reconcile.
async function chatTurn(req, res, user) {
  const { goal_id, message, conversation_history, current_plan } = req.body || {};
  if (!goal_id || !message || !current_plan) {
    return res.status(422).json({ message: 'Validation failed', errors: { message: ['goal_id, message, and current_plan are required.'] } });
  }

  const goalRows = await sql`SELECT * FROM goals WHERE id = ${goal_id} AND user_id = ${user.id}`;
  const goal = goalRows[0];
  if (!goal) return res.status(404).json({ message: 'Goal not found' });

  const pillar_name = PILLARS[goal.pillar_id];
  const pillarKey = (pillar_name || '').toLowerCase();
  const questionnaire_answers = await loadQuestionnaireAnswers(user.id, goal.pillar_id);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ message: 'ANTHROPIC_API_KEY not set on the server' });

  const system = [
    SYSTEM,
    PILLAR_PRINCIPLES[pillarKey],
    REFINE_MODE_ADDENDUM,
    `Pillar: ${pillar_name}`,
    profileContext(user),
    questionnaire_answers ? `Activation questionnaire answers: ${JSON.stringify(questionnaire_answers)}` : null,
    valueprintContext(user.valueprint_data, pillar_name),
    `Current plan (JSON) -- this is the plan as it stands right now, before this turn's message:\n${JSON.stringify(current_plan)}`,
  ].filter(Boolean).join('\n\n');

  const history = Array.isArray(conversation_history) ? conversation_history : [];
  const messages = [...history, { role: 'user', content: message }];

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        temperature: 0.4,
        system,
        tools: [REFINE_TOOL],
        tool_choice: { type: 'tool', name: 'update_refined_plan' },
        messages,
      }),
    });
    const data = await r.json();
    if (data.stop_reason === 'max_tokens') {
      console.error('goals.refine-chat: response truncated at max_tokens', { goal_id, user_id: user.id });
    }
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'update_refined_plan');
    if (!toolUse) throw new Error('No tool_use block in response');

    const { reply, planChanged, plan: rawPlan } = toolUse.input || {};
    const plan = rawPlan?.title ? moveTipPhrasedActionsToTips({ ...current_plan, ...rawPlan }) : current_plan;
    // A dailyAnchor edit changes what "your first step" should visually point at even
    // before Approve resyncs real tasks -- keep the live preview honest without a second
    // AI call. Once finalized, applyPlanToTasksAndRoutines recomputes the real one
    // (possibly a scheduled sub-task with a real taskId) the same way fresh generation does.
    const firstStep = plan.dailyAnchor ? { type: 'routine', name: plan.dailyAnchor } : (current_plan.firstStep || null);

    res.status(200).json({
      reply: reply || "Okay, here's the updated plan.",
      planChanged: !!planChanged,
      plan: { ...current_plan, ...plan, firstStep },
    });
  } catch (e) {
    console.error('goals.refine-chat: AI call failed', { goal_id, user_id: user.id, error: String(e) });
    return res.status(500).json({ message: "Couldn't process that -- try again." });
  }
}

// "Approve This Plan": resyncs the goal's REAL routines/tasks to whatever plan state the
// conversation landed on, using the exact same applyPlanToTasksAndRoutines() that fresh
// generation uses -- then the frontend runs its normal acceptPillarPlan() activation on
// top, unchanged. Old pending content is cleared first with the same "status='Pending'
// only, routines deactivated" rule generateGoal()'s own retake-supersede step uses, so a
// Completed task's XP/history is never touched, only never-done content from the
// pre-refinement draft.
async function finalizePlan(req, res, user) {
  const { goal_id, plan } = req.body || {};
  if (!goal_id || !plan?.title) {
    return res.status(422).json({ message: 'Validation failed', errors: { plan: ['goal_id and a plan with a title are required.'] } });
  }

  const goalRows = await sql`SELECT * FROM goals WHERE id = ${goal_id} AND user_id = ${user.id}`;
  const goal = goalRows[0];
  if (!goal) return res.status(404).json({ message: 'Goal not found' });

  const pillar_name = PILLARS[goal.pillar_id];
  const questionnaire_answers = await loadQuestionnaireAnswers(user.id, goal.pillar_id);
  const cleaned = moveTipPhrasedActionsToTips(plan);

  await sql`UPDATE routines SET is_active = false WHERE goal_id = ${goal_id} AND is_active = true`;
  await sql`DELETE FROM tasks WHERE goal_id = ${goal_id} AND status = 'Pending'`;

  const today = new Date().toISOString().split('T')[0];
  const end_date = goal.timeline_type === 'strict'
    ? goal.end_date
    : (() => { const days = parseTimelineDays(cleaned.timeline); return days ? addDays(today, days) : goal.end_date; })();

  await sql`
    UPDATE goals SET title = ${cleaned.title}, why = ${cleaned.why || null}, timeline = ${cleaned.timeline || null},
      daily_anchor = ${cleaned.dailyAnchor || null}, phases = ${JSON.stringify(cleaned.phases || [])}::jsonb,
      milestones = ${JSON.stringify(cleaned.milestones || [])}::jsonb, alts = ${JSON.stringify(cleaned.alts || [])}::jsonb,
      tips = ${JSON.stringify(cleaned.tips || [])}::jsonb, end_date = ${end_date}
    WHERE id = ${goal_id}
  `;

  const firstStep = await applyPlanToTasksAndRoutines(user, goal_id, goal.pillar_id, pillar_name, goal.type, cleaned, questionnaire_answers);

  res.status(200).json({
    data: { id: goal_id, pillar: pillar_name, type: goal.type, timelineType: goal.timeline_type, endDate: end_date, firstStep, ...cleaned },
  });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const action = req.query?.action || req.body?.action;
  if (action === 'finalize') return finalizePlan(req, res, user);
  return chatTurn(req, res, user);
}

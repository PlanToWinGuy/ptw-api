import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { addDays, parseTimelineDays } from '../../lib/scheduling.js';
import { SYSTEM, PILLAR_PRINCIPLES, DIET_ADDENDUM, moveTipPhrasedActionsToTips, valueprintContext, profileContext, applyPlanToTasksAndRoutines, applyDietMealPlans } from '../goals.js';

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

// Diet plans carry real starter meal plans + daily targets as first-class parts of the
// plan (see DIET_ADDENDUM), not just phases/tips -- without this, a preference raised in
// chat (e.g. "no fish") only ever changed the conversational reply and generic plan text,
// never the actual meal plan records the Meal Hub/grocery list/logging all read from,
// since those never round-tripped through the refine tool call at all. This is the fix:
// mealPlans/dailyTargets are now real fields of the tool's "plan" object (see
// buildRefineTool below) whenever this is a Diet goal, so an AI-issued swap here flows
// straight into finalizePlan()'s applyDietMealPlans() call, exactly like a fresh generation.
const REFINE_DIET_ADDENDUM = `This plan also has real starter meal plans ("mealPlans") and daily calorie/macro targets ("dailyTargets") as full first-class parts of the plan, exactly like phases/tips -- always return their complete current state in your tool call (copied through unchanged unless this turn concerns them), formatted per your original generation instructions:
${DIET_ADDENDUM}
Critical: if they mention any dietary restriction, allergy, dislike, or ingredient to avoid (e.g. "no fish", "I'm allergic to peanuts", "cutting dairy"), don't just acknowledge it in "reply" -- actually rewrite every affected entry in "mealPlans" (swap the whole meal for a different one if removing the ingredient would break the recipe, not just delete an ingredient line) so no restricted/disliked item remains anywhere in the plan. This is a real correctness requirement, not a suggestion -- a plan that still lists a restricted ingredient after they raised it is wrong.`;

// Grounds real-world facts the model wouldn't reliably know/could hallucinate (e.g. "what
// are DQ Blizzard calories") -- product owner's own example, raised in the context of a
// Diet refinement conversation about swapping/adding a specific real food. Anthropic's
// Messages API has a built-in server-side web search tool -- no second AI provider/API key
// needed for this, just another entry in `tools`. Capped with max_uses since this is a
// refinement chat turn, not open-ended research -- one fact-check is the common case, a
// few more covers a multi-part question.
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
const WEB_SEARCH_ADDENDUM = `You also have a web_search tool. Use it when you need a specific real-world fact you're not fully confident about -- a menu item's actual nutrition numbers, a current price, a specific product's ingredients -- anything you'd otherwise be guessing at or could get wrong. Don't search for things you already know well or that don't need to be current. Searching never replaces the mandatory update_refined_plan call below -- always finish the turn by calling it, whether or not you searched first.`;

const REFINE_TOOL_PLAN_BASE = {
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
};

// Diet's mealPlans/dailyTargets are only added to the tool schema (and required) for
// Diet goals -- other pillars' plan shape is unchanged.
function buildRefineTool(pillarKey) {
  const planSchema = { ...REFINE_TOOL_PLAN_BASE, properties: { ...REFINE_TOOL_PLAN_BASE.properties }, required: [...REFINE_TOOL_PLAN_BASE.required] };
  if (pillarKey === 'diet') {
    planSchema.properties.dailyTargets = {
      type: 'object',
      properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } },
    };
    planSchema.properties.mealPlans = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, mealType: { type: 'string' }, calories: { type: 'number' },
          protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' },
          ingredients: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'string' } }, required: ['name'] } },
          instructions: { type: 'string' },
        },
        required: ['name', 'mealType', 'ingredients'],
      },
    };
    planSchema.required = [...planSchema.required, 'mealPlans'];
  }
  return {
    name: 'update_refined_plan',
    description: "Reply to the user's refinement message and return the plan's full current state (changed by this turn, or copied through unchanged).",
    input_schema: {
      type: 'object',
      properties: {
        reply: { type: 'string', description: 'Conversational, second-person reply, 1-4 sentences: explain what you changed and why, answer their question, or ask a clarifying question.' },
        planChanged: { type: 'boolean', description: 'true only if "plan" differs from what was given to you this turn.' },
        plan: planSchema,
      },
      required: ['reply', 'planChanged', 'plan'],
    },
  };
}

async function loadQuestionnaireAnswers(userId, pillarId) {
  const rows = await sql`SELECT answers FROM pillar_answers WHERE user_id = ${userId} AND pillar_id = ${pillarId} ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.answers || null;
}

// Thin wrapper around one Messages API call -- chatTurn() below can make up to three of
// these in a turn (main call, an optional pause_turn continuation, an optional forced
// fallback), all sharing the exact same request shape apart from tools/tool_choice/messages.
async function postRefineTurn(key, { system, tools, tool_choice, messages, maxTokens }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, temperature: 0.4, system, tools, tool_choice, messages }),
  });
  return r.json();
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
    pillarKey === 'diet' ? REFINE_DIET_ADDENDUM : null,
    WEB_SEARCH_ADDENDUM,
    `Pillar: ${pillar_name}`,
    profileContext(user),
    questionnaire_answers ? `Activation questionnaire answers: ${JSON.stringify(questionnaire_answers)}` : null,
    valueprintContext(user.valueprint_data, pillar_name),
    `Current plan (JSON) -- this is the plan as it stands right now, before this turn's message:\n${JSON.stringify(current_plan)}`,
  ].filter(Boolean).join('\n\n');

  const history = Array.isArray(conversation_history) ? conversation_history : [];
  const messages = [...history, { role: 'user', content: message }];

  try {
    // Diet's tool call now also has to reproduce a full mealPlans array (name/macros/
    // ingredients/instructions per meal, same granularity as DIET_ADDENDUM) every turn --
    // 4000 was already the generic plan's ceiling before that; matches goals.js's own
    // maxTokens bump for the exact same reason (a truncated mid-JSON tool call silently
    // falls back to the current unchanged plan below instead of applying the real edit).
    const maxTokens = pillarKey === 'diet' ? 6500 : 4000;
    const refineTool = buildRefineTool(pillarKey);

    // tool_choice can no longer force update_refined_plan directly on the main call --
    // forcing a specific tool tells the model it must call THAT tool as its very next
    // action, which never leaves room to call the server-side web_search tool first (see
    // Anthropic's docs on mixing server tools with a forced client tool_choice). So this
    // call uses "auto" plus an explicit system-prompt mandate (REFINE_MODE_ADDENDUM/
    // WEB_SEARCH_ADDENDUM above) instead -- Claude can search, then call update_refined_plan
    // itself, same as any normal agentic turn. The forced-tool guarantee comes back as a
    // fallback below for the rare turn where the model doesn't comply on its own.
    let data = await postRefineTurn(key, { system, tools: [WEB_SEARCH_TOOL, refineTool], tool_choice: { type: 'auto' }, messages, maxTokens });

    // A long search turn can come back paused mid-loop (stop_reason: "pause_turn") --
    // resend the assistant content as-is to let the server-side search loop continue.
    // Capped, like any retry loop, rather than trusting an upstream state machine forever.
    let loopMessages = messages;
    let pauses = 0;
    while (data.stop_reason === 'pause_turn' && pauses < 3) {
      loopMessages = [...loopMessages, { role: 'assistant', content: data.content }];
      data = await postRefineTurn(key, { system, tools: [WEB_SEARCH_TOOL, refineTool], tool_choice: { type: 'auto' }, messages: loopMessages, maxTokens });
      pauses++;
    }

    if (data.stop_reason === 'max_tokens') {
      console.error('goals.refine-chat: response truncated at max_tokens', { goal_id, user_id: user.id });
    }
    let toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'update_refined_plan');

    // Fallback: the model searched (or just talked) and ended its turn without ever
    // calling update_refined_plan, breaking the "every turn MUST call it" contract auto
    // tool_choice can no longer guarantee on its own. One more call, forced this time (no
    // web_search tool offered, so there's nothing left for it to do but comply), with the
    // prior turn's content -- including anything it found via search -- kept in context so
    // the plan update still reflects what it just learned.
    if (!toolUse) {
      const retryMessages = [
        ...loopMessages,
        { role: 'assistant', content: data.content },
        { role: 'user', content: "Continue: call update_refined_plan now with your reply and the plan's full current state." },
      ];
      data = await postRefineTurn(key, { system, tools: [refineTool], tool_choice: { type: 'tool', name: 'update_refined_plan' }, messages: retryMessages, maxTokens });
      toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'update_refined_plan');
    }
    if (!toolUse) throw new Error('No tool_use block in response');

    const { reply, planChanged, plan: rawPlan } = toolUse.input || {};
    const plan = rawPlan?.title ? moveTipPhrasedActionsToTips({ ...current_plan, ...rawPlan }) : current_plan;
    // A dailyAnchor edit changes what "your first step" should visually point at even
    // before Approve resyncs real tasks -- keep the live preview honest without a second
    // AI call. Once finalized, applyPlanToTasksAndRoutines recomputes the real one
    // (possibly a scheduled sub-task with a real taskId) the same way fresh generation does.
    const firstStep = plan.dailyAnchor ? { type: 'routine', name: plan.dailyAnchor } : (current_plan.firstStep || null);

    logCoachSession(user.id, message, reply, false);
    res.status(200).json({
      reply: reply || "Okay, here's the updated plan.",
      planChanged: !!planChanged,
      plan: { ...current_plan, ...plan, firstStep },
    });
  } catch (e) {
    console.error('goals.refine-chat: AI call failed', { goal_id, user_id: user.id, error: String(e) });
    logCoachSession(user.id, message, null, true);
    return res.status(500).json({ message: "Couldn't process that -- try again." });
  }
}

// Fire-and-forget row for the admin panel's Coaching Oversight section (see
// api/ai/chat.js's own copy of this pattern) -- truncated excerpts only, never awaited.
function logCoachSession(userId, userMessage, aiReply, hadError) {
  sql`
    INSERT INTO coach_sessions (user_id, kind, user_message, ai_reply, had_error)
    VALUES (${userId}, 'goal_refine', ${String(userMessage || '').slice(0, 500)}, ${aiReply ? String(aiReply).slice(0, 500) : null}, ${hadError})
  `.catch(e => console.error('coach_sessions insert failed', String(e)));
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

  // Diet: regenerate the real meal plan records (metric_logs) + daily targets + meal-log
  // routines from whatever mealPlans/dailyTargets the conversation landed on -- see
  // applyDietMealPlans()'s own comment for why this call is the actual fix for a chat-raised
  // preference (e.g. "no fish") previously never reaching real meal plan data. No-op for
  // any goal whose finalized plan has no mealPlans array (non-Diet pillars, or a Diet plan
  // predating this feature that the conversation never touched).
  await applyDietMealPlans(user, goal_id, goal.pillar_id, pillar_name, cleaned);

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

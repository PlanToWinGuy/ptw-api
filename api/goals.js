import { sql, PILLARS, pillarIdFromName } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { timeOfDayToClock, addMinutesToClock, addDays, inferToolHint, isRecurringAction, parseTimelineDays, scheduleSubTasks } from '../lib/scheduling.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Mirrors map-of-you's GOAL_PLAN_SYSTEM shape exactly, so a plan generated on the
// Map site and one generated here are interchangeable.
const SYSTEM = `You create a personalized goal plan from someone's pillar, goal type, and situation. The timeline depends on the goal type and starting point — not everything is 90 days. Return ONLY JSON:
{
  "title": "<specific goal title — what they will achieve, 1 sentence>",
  "timeline": "<e.g. '21 days', '6 weeks', '60 days', '90 days' — based on type + stage>",
  "why": "<why this fits their situation — 1-2 sentences, second person>",
  "phases": [
    {"label": "<phase name e.g. Foundation>", "duration": "<e.g. Days 1-14>", "focus": "<what this phase builds>", "actions": ["<action>", "<action>"]}
  ],
  "dailyAnchor": "<The one keystone habit that holds everything together — specific and doable>",
  "milestones": [
    {"label": "<e.g. Week 1>", "marker": "<what they should notice or be able to do>"}
  ],
  "alts": ["<alternative version — different approach, same destination>"]
}
Timeline logic: habits need 21-66 days (fresh start=66, tried+stopped=30, in progress=21 to cement). Projects 60-90 days. Skills 90 days min. Mindset 30-60 days daily practice.
If a Valueprint reading is provided (archetype, growth edge, pillar alignment), ground the "why" in it specifically — reference their actual edge or alignment gap, not generic encouragement.
For a significant, quantifiable goal (e.g. "lose 20kg", "save $10,000"), first work out a realistic, science-based rate (e.g. weight loss: 0.5-1kg/week) and let that rate set the timeline and milestones — don't just default to a round number of days.`;

// Science-backed reasoning rules per pillar (from the Pillar Playbooks doc) -- appended to
// SYSTEM based on which pillar is generating, so the AI's judgment calls are grounded in
// the same principles across every generation, not just vibes.
const PILLAR_PRINCIPLES = {
  fitness: `Fitness principles: always include a daily step target (~8,000) alongside any training plan. For Strength Training/Build Muscle goals, use progressive overload — assign a target rep range and note that logging reps beyond the target on the final set is the signal to increase weight next session.`,
  diet: `Diet principles: base calorie targets on their stated goal direction (deficit for weight loss, surplus for muscle gain) relative to an estimated TDEE from their profile. If they rarely cook, shift from recipes to meal suggestions and healthy takeaway guidelines instead.`,
  finances: `Finance principles: if they don't currently track spending, the first phase must be establishing a simple daily/weekly expense-tracking habit before anything else. If their goal is getting out of debt, that takes priority over every other financial goal (use a debt-snowball-style approach). If income is variable/freelance, budget for a larger emergency fund. Any investing suggestion must match their stated risk tolerance.`,
  relations: `Relations principles: filter every suggestion through their stated focus area and preferred way to connect (quality time, words of affirmation, etc.) so actions feel natural, not generic. If their initiative style is "I tend to wait," bias tasks toward building proactive-outreach habits.`,
  personal: `Personal principles: match tasks to their preferred learning style (reading/listening/watching/doing). For travel or itinerary-style goals, generate specific day-by-day actionable stops, not vague suggestions.`,
  work: `Work principles: activate a concrete playbook matching their primary work goal (e.g. "Find a New Job" -> resume, networking tasks). Adapt suggestions to their work environment (remote users need boundary-setting, not open-office focus tips). If they need help finding a system, recommend one concrete methodology (e.g. Time-Blocking) and build tasks around implementing it.`,
};

// Appended to SYSTEM only for Fitness -- asks for real starter workout plans in the same
// call rather than a second AI request, so this doesn't add extra cost.
const FITNESS_ADDENDUM = `
Also include a "workoutPlans" array — 2 concrete starter workout plans matching their equipment/experience/split from the questionnaire:
"workoutPlans": [
  {"name": "<e.g. Push Day A>", "durationMin": <number>, "exercises": [
    {"name": "<exercise>", "sets": <number>, "targetReps": <number>, "targetWeight": <number, kg, 0 if bodyweight>}
  ]}
]
2-3 plans, 4-6 exercises each, sets/reps/weight appropriate to their stated experience level and equipment.`;

// Appended to SYSTEM only for Diet -- same reasoning as FITNESS_ADDENDUM: real starter meal
// plans (recipe-grained, matching the workoutPlans granularity of "one plan = one session")
// in the same call, plus a real per-ingredient list so the Grocery List can genuinely sync
// to what the plan requires instead of staying a disconnected manual checklist.
const DIET_ADDENDUM = `
Also include a "dailyTargets" object and a "mealPlans" array.
"dailyTargets": {"calories": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>}
Estimate a real TDEE from whatever profile signals are available (age/weight/sex/activity level if present, else reasonable adults-in-general defaults) and adjust for their stated goal direction (deficit for weight loss, surplus for muscle gain, maintenance otherwise) per the Diet principles above -- this becomes their actual daily target, not a placeholder.
"mealPlans": [
  {"name": "<e.g. High-Protein Overnight Oats>", "mealType": "<Breakfast|Lunch|Dinner|Snack>", "calories": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>,
   "ingredients": [{"name": "<ingredient>", "qty": "<e.g. '200g' or '2'>"}],
   "instructions": "<short 2-4 step prep, or 'Order from a healthy option matching these macros' if they rarely cook>"}
]
3 plans covering different meal types, respecting any dietary restrictions/dislikes exactly (never include a restricted or disliked ingredient). If they rarely cook, keep instructions store-bought/takeaway-oriented rather than recipe-heavy.`;

// Appended to SYSTEM only for Finances -- a real starter budget in the same call, using the
// same 4-category model (Needs/Wants/Savings/Debt) the Finance Hub's transaction logging
// already uses, so a fresh budget target isn't a blank $2500 the user has to type in
// themselves before the Budgets tab means anything.
const FINANCE_ADDENDUM = `
Also include a "budgetPlan" object:
"budgetPlan": {
  "monthlyBudget": <number, total monthly spending target>,
  "categoryAllocations": [{"category": "Needs", "amount": <number>}, {"category": "Wants", "amount": <number>}, {"category": "Savings", "amount": <number>}, {"category": "Debt", "amount": <number>}],
  "savingsGoal": {"name": "<e.g. Emergency Fund>", "target": <number>} or null if their goal isn't savings-related,
  "debtPayoffPlan": {"strategy": "<e.g. Debt Snowball>", "note": "<1 sentence on the approach>"} or null if debt isn't relevant
}
categoryAllocations must sum to monthlyBudget. Base monthlyBudget on whatever income/spending signals are available in their answers, else a reasonable general estimate. If income is variable/freelance, bias Savings higher for a buffer. If their goal is debt-related, prioritize Debt allocation and always include debtPayoffPlan; otherwise debtPayoffPlan is null.`;

// Transactions are logged against exactly these 4 categories (see FINANCE_CATEGORIES in the
// frontend) -- the AI sometimes elaborates a category name in its own text ("Savings (Income
// Buffer)"), which would silently break the exact-string match the Budgets tab's vs-actual
// breakdown depends on. Normalized on the way in rather than trusting the AI's exact wording.
const FINANCE_CATEGORY_ORDER = ['Needs', 'Wants', 'Savings', 'Debt'];
function normalizeFinanceCategory(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('debt')) return 'Debt';
  if (s.includes('need')) return 'Needs';
  if (s.includes('want')) return 'Wants';
  if (s.includes('sav')) return 'Savings';
  return FINANCE_CATEGORY_ORDER.includes(raw) ? raw : 'Wants';
}

const GOAL_TYPES = new Set(['habit', 'project', 'skill', 'mindset']);

// Static complementary-pillar map for the Synergy card -- deterministic, no AI call.
// Personal is the hub several other pillars point to; its own card points back at Work
// as the single most common pairing rather than listing all three.
const SYNERGY_MAP = { fitness: 'diet', diet: 'fitness', work: 'personal', personal: 'work', finances: 'personal', relations: 'personal' };

function serialize(g, strategyCards) {
  return {
    id: g.id,
    pillar: PILLARS[g.pillar_id] || null,
    type: g.type,
    title: g.title,
    goal: g.title,
    why: g.why,
    timeline: g.timeline,
    timelineType: g.timeline_type,
    endDate: g.end_date,
    dailyAnchor: g.daily_anchor,
    phases: g.phases,
    milestones: g.milestones,
    alts: g.alts,
    difficulty: g.difficulty,
    created_at: g.created_at,
    strategyCards: strategyCards || [],
  };
}

// Strategy Cards for the Roadmap's "AI Strategy" section -- computed deterministically
// from data already on hand (questionnaire answers, workout plan templates, linked
// routines, unlocked pillars) rather than a second AI call. Replaces the dead
// `g.strategy` field the frontend used to read (never populated by the AI prompt).
async function buildStrategyCards(user, g, unlockedPillarIds) {
  const pillarName = (PILLARS[g.pillar_id] || '').toLowerCase();
  const cards = [];

  if (pillarName === 'fitness') {
    const [{ count: planCount }] = await sql`SELECT COUNT(*)::int AS count FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${g.pillar_id} AND log_type = 'workout_plan'`;
    const answersRows = await sql`SELECT answers FROM pillar_answers WHERE user_id = ${user.id} AND pillar_id = ${g.pillar_id} ORDER BY created_at DESC LIMIT 1`;
    const answers = answersRows[0]?.answers || {};
    if (planCount || answers.weekly_days || answers.activity_type) {
      cards.push({
        type: 'workouts',
        title: 'Your Training Plan',
        body: [
          answers.weekly_days ? `${answers.weekly_days} workouts/week` : null,
          answers.activity_type ? `focused on ${answers.activity_type}` : null,
          planCount ? `${planCount} starter plan${planCount === 1 ? '' : 's'} ready in your Workout Hub` : null,
        ].filter(Boolean).join(' · '),
        // Raw number (not just the formatted body above) so the Fitness Map's Today's
        // Workout card can compare it against actual logged workouts this week.
        weeklyTarget: answers.weekly_days ? Number(answers.weekly_days) : null,
      });
    }
  }

  if (pillarName === 'diet') {
    const [{ count: planCount }] = await sql`SELECT COUNT(*)::int AS count FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${g.pillar_id} AND log_type = 'meal_plan'`;
    const answersRows = await sql`SELECT answers FROM pillar_answers WHERE user_id = ${user.id} AND pillar_id = ${g.pillar_id} ORDER BY created_at DESC LIMIT 1`;
    const answers = answersRows[0]?.answers || {};
    if (planCount || answers.restrictions) {
      const restrictions = Array.isArray(answers.restrictions) ? answers.restrictions.filter(r => r && r !== 'No Restrictions') : [];
      cards.push({
        type: 'meals',
        title: 'Your Meal Plan',
        body: [
          restrictions.length ? restrictions.join(', ') : null,
          planCount ? `${planCount} starter meal plan${planCount === 1 ? '' : 's'} ready in your Meal Hub` : null,
        ].filter(Boolean).join(' · ') || `${planCount} starter meal plans ready in your Meal Hub`,
      });
    }
  }

  if (pillarName === 'finances') {
    const budgetRows = await sql`SELECT value FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${g.pillar_id} AND log_type = 'budget_goal' LIMIT 1`;
    const answersRows = await sql`SELECT answers FROM pillar_answers WHERE user_id = ${user.id} AND pillar_id = ${g.pillar_id} ORDER BY created_at DESC LIMIT 1`;
    const answers = answersRows[0]?.answers || {};
    if (budgetRows.length || answers.primary_goal) {
      cards.push({
        type: 'budget',
        title: 'Your Budget Plan',
        body: [
          budgetRows.length ? `$${Number(budgetRows[0].value).toLocaleString()}/month target` : null,
          answers.primary_goal ? `focused on ${answers.primary_goal}` : null,
        ].filter(Boolean).join(' · ') || 'Set up in your Finance Hub',
      });
    }
  }

  const routineRows = await sql`SELECT name FROM routines WHERE goal_id = ${g.id} AND is_active = true ORDER BY created_at ASC`;
  if (routineRows.length) {
    cards.push({
      type: 'habits',
      title: 'Daily Habit Added',
      body: routineRows.length === 1
        ? `"${routineRows[0].name}" has been added to your daily schedule -- it'll show up every day for the life of this plan.`
        : `${routineRows.length} daily habits have been added to your schedule -- they'll show up every day for the life of this plan.`,
    });
  }

  const complementKey = SYNERGY_MAP[pillarName];
  if (complementKey) {
    const complementId = pillarIdFromName(complementKey);
    const complementLabel = PILLARS[complementId];
    const isUnlocked = unlockedPillarIds.has(complementId);
    cards.push({
      type: 'synergy',
      title: 'Synergy',
      body: isUnlocked
        ? `Your ${complementLabel} plan is already active -- keep both moving together for compounding results.`
        : `Your ${complementLabel} pillar isn't active yet -- activating it could accelerate results here.`,
      targetPillar: complementLabel,
      pillarActive: isUnlocked,
    });
  }

  return cards;
}

async function listGoals(req, res, user) {
  const pillar_id = req.query.pillar_id ? Number(req.query.pillar_id) : null;
  // is_active excludes a plan that's been superseded by a retake -- only ever one
  // live goal per pillar going forward (see the cleanup step in generateGoal()).
  const rows = pillar_id
    ? await sql`SELECT * FROM goals WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND is_active = true ORDER BY created_at DESC LIMIT 1`
    : await sql`SELECT * FROM goals WHERE user_id = ${user.id} AND is_active = true ORDER BY created_at DESC`;

  const unlockedRows = await sql`SELECT pillar_id FROM user_pillars WHERE user_id = ${user.id}`;
  const unlockedPillarIds = new Set(unlockedRows.map(r => r.pillar_id));

  const data = await Promise.all(rows.map(async g => serialize(g, await buildStrategyCards(user, g, unlockedPillarIds))));
  res.status(200).json({ data });
}

// Pulls the Map of You reading into plan generation -- the archetype/edge/gap for this
// specific pillar, so a goal is grounded in the person's actual values, not just the
// questionnaire. Personal benefits most (mindset/identity work), but every pillar gets it.
function valueprintContext(valueprint_data, pillar_name) {
  if (!valueprint_data) return null;
  const gapEntry = Array.isArray(valueprint_data.gap)
    ? valueprint_data.gap.find(g => (g?.pillar || '').toLowerCase() === pillar_name.toLowerCase())
    : null;
  // firstMoves are the reading's own concrete if-then suggestion for THIS pillar --
  // when one exists, it's a strong signal for the daily anchor or an early phase action.
  const moveEntry = Array.isArray(valueprint_data.firstMoves)
    ? valueprint_data.firstMoves.find(m => (m?.pillar || '').toLowerCase() === pillar_name.toLowerCase())
    : null;
  const values = Array.isArray(valueprint_data.code)
    ? valueprint_data.code.map(c => c?.value).filter(Boolean).join(', ')
    : null;
  const lines = [
    valueprint_data.archetype ? `Archetype: ${valueprint_data.archetype}` : null,
    valueprint_data.oneLiner ? `Who they're becoming: ${valueprint_data.oneLiner}` : null,
    values ? `Their core values: ${values}` : null,
    valueprint_data.edge ? `Their growth edge: ${valueprint_data.edge}` : null,
    gapEntry ? `${pillar_name} alignment right now: ${gapEntry.alignmentPct}% — ${gapEntry.note || ''}` : null,
    moveEntry ? `Their own suggested first move for ${pillar_name}: ${moveEntry.ifthen}` : null,
  ].filter(Boolean);
  return lines.length ? 'From their Valueprint (Map of You reading):\n' + lines.join('\n') : null;
}

// Different pillars name their first question differently (primary_goal, focus_area, ...),
// so pull whatever's there rather than assuming one fixed key.
function deriveGoalText(answers, pillarName) {
  if (!answers) return null;
  for (const k of ['primary_goal', 'focus_area', 'key_skill', 'notes']) {
    if (answers[k]) return answers[k];
  }
  const firstString = Object.values(answers).find(v => typeof v === 'string' && v.trim());
  return firstString || `Build a ${pillarName} plan`;
}

async function generateGoal(req, res, user) {
  const body = req.body || {};
  const pillar_name = body.pillar_name;
  const questionnaire_answers = body.questionnaire_answers || null;
  const user_goal = body.user_goal || deriveGoalText(questionnaire_answers, pillar_name);
  const goal_type = GOAL_TYPES.has(body.goal_type) ? body.goal_type : 'project';
  const goal_difficulty = body.goal_difficulty || 3;
  const timeline_type = body.timeline_type === 'strict' ? 'strict' : 'dynamic';
  const target_end_date = body.target_end_date || null; // Strict only -- user-picked deadline

  if (!pillar_name || !user_goal) {
    return res.status(422).json({ message: 'Validation failed', errors: { user_goal: ['pillar_name and (user_goal or questionnaire_answers) are required.'] } });
  }

  // Cost backstop: nobody legitimately needs unlimited plan regenerations in a day —
  // this is a cap against runaway loops/bugs, not a real usage limit. 20 turned out to be
  // low enough that a founder actively testing/retaking a pillar's assessment repeatedly
  // in one day for real QA work hit it legitimately -- 100 still catches an actual runaway
  // loop while giving real iterative testing room to breathe.
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM goals WHERE user_id = ${user.id} AND created_at > now() - interval '1 day'`;
  if (count >= 100) {
    return res.status(429).json({ message: 'Too many plans generated today — try again tomorrow.' });
  }

  const pillar_id = pillarIdFromName(pillar_name);

  // Retaking an assessment or regenerating a plan replaces the pillar's whole plan --
  // deactivate the previous one (stop its recurring routines, clear its not-yet-done
  // tasks) instead of piling up duplicate "do X daily" content alongside the new plan.
  // Already-Completed tasks are left untouched so past XP/streaks aren't retroactively
  // erased.
  const supersededGoals = await sql`
    UPDATE goals SET is_active = false WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND is_active = true
    RETURNING id
  `;
  if (supersededGoals.length) {
    const oldGoalIds = supersededGoals.map(g => g.id);
    await sql`UPDATE routines SET is_active = false WHERE goal_id = ANY(${oldGoalIds})`;
    await sql`DELETE FROM tasks WHERE goal_id = ANY(${oldGoalIds}) AND status = 'Pending'`;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  let plan = {
    title: user_goal,
    timeline: '30 days',
    why: `Grounded in ${pillar_name.toLowerCase()}, built around what you told us.`,
    phases: [{ label: 'Foundation', duration: 'Days 1-14', focus: 'Build the base', actions: [user_goal] }],
    dailyAnchor: user_goal,
    milestones: [{ label: 'Week 1', marker: 'First consistent week' }],
    alts: [],
  };

  if (key) {
    try {
      // 4000 (5000 for Fitness/Diet, which also have to fit their real starter plans array
      // on top of the normal phases/milestones/alts in the same response) -- 2400 was too
      // tight for a detailed multi-phase plan and silently truncated mid-JSON on at least
      // one real account, which JSON.parse then threw on, falling all the way back to the
      // generic 1-milestone default plan with zero visibility into why.
      const maxTokens = ['fitness', 'diet'].includes(pillar_name.toLowerCase()) ? 5000 : 4000;
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          temperature: 0.4,
          system: [
            SYSTEM,
            PILLAR_PRINCIPLES[pillar_name.toLowerCase()],
            pillar_name.toLowerCase() === 'fitness' ? FITNESS_ADDENDUM : null,
            pillar_name.toLowerCase() === 'diet' ? DIET_ADDENDUM : null,
            pillar_name.toLowerCase() === 'finances' ? FINANCE_ADDENDUM : null,
          ].filter(Boolean).join('\n\n'),
          messages: [{ role: 'user', content: [
            `Pillar: ${pillar_name}`,
            `Goal type: ${goal_type}`,
            `Goal: ${user_goal}`,
            `Difficulty: ${goal_difficulty}/5`,
            questionnaire_answers ? `Activation questionnaire answers: ${JSON.stringify(questionnaire_answers)}` : null,
            valueprintContext(user.valueprint_data, pillar_name),
          ].filter(Boolean).join('\n') }],
        }),
      });
      const data = await r.json();
      if (data.stop_reason === 'max_tokens') {
        console.error('goals.generate: response truncated at max_tokens', { pillar_name, maxTokens, user_id: user.id });
      }
      const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
      const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
      if (parsed.title) plan = { ...plan, ...parsed };
    } catch (e) {
      // Falls back to the generic default plan above -- logged so a real failure (bad
      // JSON, truncation, API error) is diagnosable instead of silently invisible.
      console.error('goals.generate: AI call failed, using fallback plan', { pillar_name, user_id: user.id, error: String(e) });
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const pillarKey = pillar_name.toLowerCase();
  const clockStart = timeOfDayToClock(questionnaire_answers?.time_of_day);

  // Dynamic (default): end_date is a best-effort estimate parsed from the AI's own
  // timeline text, purely informational until Plan Shift starts adjusting it. Strict:
  // the user's own chosen deadline, already feasibility-checked before this call.
  const end_date = timeline_type === 'strict' && target_end_date
    ? target_end_date
    : (() => { const days = parseTimelineDays(plan.timeline); return days ? addDays(today, days) : null; })();

  const goalRows = await sql`
    INSERT INTO goals (user_id, pillar_id, type, title, why, timeline, daily_anchor, phases, milestones, alts, difficulty, timeline_type, end_date)
    VALUES (${user.id}, ${pillar_id}, ${goal_type}, ${plan.title}, ${plan.why || null}, ${plan.timeline || null},
            ${plan.dailyAnchor || null}, ${JSON.stringify(plan.phases || [])}::jsonb,
            ${JSON.stringify(plan.milestones || [])}::jsonb, ${JSON.stringify(plan.alts || [])}::jsonb, ${goal_difficulty},
            ${timeline_type}, ${end_date})
    RETURNING id
  `;
  const goal_id = goalRows[0].id;

  // The Review Blueprint highlights whichever real, concrete action the user will actually
  // do first -- a scheduled sub-task if one exists, else the daily anchor habit/routine.
  // Ties the plan back to the Valueprint/mapper framing ("this whole plan traces back to
  // one real action") without a second AI call -- it's just the first thing already in `plan`.
  let firstStep = plan.dailyAnchor ? { type: 'routine', name: plan.dailyAnchor } : null;

  if (goal_type === 'habit' || goal_type === 'mindset') {
    // The daily anchor is a routine, not a one-off task -- materializes every day via
    // materializeRoutinesForDate() regardless of whether yesterday's instance was ever
    // completed, instead of the old completion-gated regeneration that silently stopped
    // forever the first time a day was missed. end_date null: habits are indefinite.
    if (plan.dailyAnchor) {
      const toolHint = inferToolHint(pillarKey, plan.dailyAnchor);
      await sql`
        INSERT INTO routines (user_id, goal_id, name, category, is_active, schedule_days, schedule_time, steps, tool_hint, end_date)
        VALUES (${user.id}, ${goal_id}, ${plan.dailyAnchor}, ${pillar_name}, true, ${[]}, ${clockStart}::time,
                ${JSON.stringify([{ name: plan.dailyAnchor, durationMinutes: 15 }])}::jsonb, ${toolHint}, NULL)
      `;
    }
  } else {
    // A project/skill goal becomes one real parent Project (kind='project', the thing
    // that shows up as a single "ProjectTask" block on the schedule) with its NON-recurring
    // phase actions as real sub-tasks (parent_task_id). An action whose own text says
    // "every day"/"daily"/etc. instead becomes its own routine (see above) -- reappearing
    // every day for the goal's duration rather than a one-off checkbox that never repeats
    // even though the plan describes it as recurring.
    const phases = plan.phases || [];
    const allActions = [];
    phases.forEach(ph => (ph.actions || []).forEach(a => allActions.push({ text: a, phaseLabel: ph.label || null })));

    const recurringActions = allActions.filter(a => isRecurringAction(a.text));
    const oneOffActions = allActions.filter(a => !isRecurringAction(a.text));

    for (const action of recurringActions) {
      const toolHint = inferToolHint(pillarKey, action.text);
      await sql`
        INSERT INTO routines (user_id, goal_id, name, category, is_active, schedule_days, schedule_time, steps, tool_hint, end_date)
        VALUES (${user.id}, ${goal_id}, ${action.text}, ${pillar_name}, true, ${[]}, ${clockStart}::time,
                ${JSON.stringify([{ name: action.text, durationMinutes: 30 }])}::jsonb, ${toolHint}, ${end_date})
      `;
    }

    if (oneOffActions.length) {
      const subtaskMinutes = 30;
      const parentRows = await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, due_date, estimated_duration_minutes)
        VALUES (${user.id}, ${goal_id}, ${pillar_id}, ${plan.title}, 'project', ${today}, ${oneOffActions.length * subtaskMinutes})
        RETURNING id
      `;
      const parent_task_id = parentRows[0].id;

      // Bin-pack sub-tasks into sequential days, each capped at the questionnaire's daily
      // time budget, with real start_time/end_time within that day's block -- the literal
      // "2-hour block of the 6-hour project, from a certain time to another" scheduling.
      const dailyBudgetMinutes = Number(questionnaire_answers?.daily_time_budget) || 60;
      const scheduled = scheduleSubTasks(oneOffActions, { startDate: today, clockStart, dailyBudgetMinutes, subtaskMinutes });

      for (let i = 0; i < scheduled.length; i++) {
        const action = scheduled[i];
        const toolHint = inferToolHint(pillarKey, action.text);
        const insertedRows = await sql`
          INSERT INTO tasks (user_id, goal_id, pillar_id, parent_task_id, name, kind, phase_label, due_date, estimated_duration_minutes, start_time, end_time, tool_hint)
          VALUES (${user.id}, ${goal_id}, ${pillar_id}, ${parent_task_id}, ${action.text}, 'simple', ${action.phaseLabel}, ${action.dueDate}, ${subtaskMinutes}, ${action.startTime}, ${action.endTime}, ${toolHint})
          RETURNING id
        `;
        // The very first scheduled sub-task, in real chronological order -- this is what
        // the Review Blueprint highlights as "your first step," a concrete tie back to the
        // Valueprint/mapper framing that this whole plan traces back to a single real action.
        if (i === 0) firstStep = { type: 'task', taskId: insertedRows[0].id, name: action.text };
      }
    }
  }

  // Fitness gets real workout plan templates stored as metric_logs, so the Workout Hub's
  // "My Plans" tab has something real to show without a second AI call.
  if (pillar_name.toLowerCase() === 'fitness' && Array.isArray(plan.workoutPlans)) {
    for (const wp of plan.workoutPlans) {
      await sql`
        INSERT INTO metric_logs (user_id, pillar_id, log_type, value, unit, data)
        VALUES (${user.id}, ${pillar_id}, 'workout_plan', ${wp.durationMin || null}, 'min',
                ${JSON.stringify({ name: wp.name, exercises: wp.exercises || [], source: 'goal' })}::jsonb)
      `;
    }
  }

  // Diet gets real meal plan templates stored as metric_logs (same pattern as Fitness's
  // workoutPlans), and their ingredients merge straight into the Grocery List -- "planning
  // a meal stocks your list; logging it later clears what you actually used" (the removal
  // half happens client-side in confirmLogMeal() when a meal is logged against a plan).
  if (pillar_name.toLowerCase() === 'diet' && Array.isArray(plan.mealPlans)) {
    const allIngredients = [];
    for (const mp of plan.mealPlans) {
      await sql`
        INSERT INTO metric_logs (user_id, pillar_id, log_type, value, unit, data)
        VALUES (${user.id}, ${pillar_id}, 'meal_plan', ${mp.calories || null}, 'kcal',
                ${JSON.stringify({ name: mp.name, mealType: mp.mealType || null, protein_g: mp.protein_g || 0, carbs_g: mp.carbs_g || 0, fat_g: mp.fat_g || 0, ingredients: mp.ingredients || [], instructions: mp.instructions || '', source: 'goal' })}::jsonb)
      `;
      (mp.ingredients || []).forEach(ing => { if (ing?.name) allIngredients.push(ing); });
    }
    if (allIngredients.length) await mergeIntoGroceryList(sql, user.id, pillar_id, allIngredients);

    // Real daily calorie/macro targets (estimated TDEE + goal-direction adjustment, see
    // DIET_ADDENDUM) replace the frontend's old hardcoded 2300kcal placeholder -- a single
    // row, same "one flexible row per user" pattern as the Grocery List, upserted so
    // retaking the assessment updates the target instead of leaving a stale one behind.
    if (plan.dailyTargets && Number(plan.dailyTargets.calories) > 0) {
      const targetsData = { calories: Number(plan.dailyTargets.calories) || 0, protein_g: Number(plan.dailyTargets.protein_g) || 0, carbs_g: Number(plan.dailyTargets.carbs_g) || 0, fat_g: Number(plan.dailyTargets.fat_g) || 0 };
      const existingTargets = await sql`SELECT id FROM metric_logs WHERE user_id = ${user.id} AND log_type = 'diet_targets' LIMIT 1`;
      if (existingTargets.length) {
        await sql`UPDATE metric_logs SET data = ${JSON.stringify(targetsData)}::jsonb, value = ${targetsData.calories} WHERE id = ${existingTargets[0].id}`;
      } else {
        await sql`INSERT INTO metric_logs (user_id, pillar_id, log_type, value, unit, data) VALUES (${user.id}, ${pillar_id}, 'diet_targets', ${targetsData.calories}, 'kcal', ${JSON.stringify(targetsData)}::jsonb)`;
      }
    }
  }

  // Finances gets a real starter budget (see FINANCE_ADDENDUM) auto-applied instead of the
  // Budgets tab starting at a blank hardcoded $2500 the user has to fill in themselves --
  // budget_goal/savings_goal use the exact same metric_logs shape setBudgetGoal()/
  // addSavingsGoal() already write client-side, so the existing Budgets tab renders them
  // with zero frontend changes; category_allocations is new, for the real vs-target
  // breakdown added to that tab below.
  if (pillar_name.toLowerCase() === 'finances' && plan.budgetPlan?.monthlyBudget) {
    const bp = plan.budgetPlan;
    const existingBudget = await sql`SELECT id FROM metric_logs WHERE user_id = ${user.id} AND log_type = 'budget_goal' LIMIT 1`;
    if (existingBudget.length) {
      await sql`UPDATE metric_logs SET value = ${bp.monthlyBudget} WHERE id = ${existingBudget[0].id}`;
    } else {
      await sql`INSERT INTO metric_logs (user_id, pillar_id, log_type, value, unit) VALUES (${user.id}, ${pillar_id}, 'budget_goal', ${bp.monthlyBudget}, 'usd')`;
    }

    if (Array.isArray(bp.categoryAllocations) && bp.categoryAllocations.length) {
      // Normalize against the fixed 4-category model transactions actually use (Needs/Wants/
      // Savings/Debt) -- the AI sometimes elaborates a category name (e.g. "Savings (Income
      // Buffer)"), which would silently break the exact-string match against real transaction
      // categories in the vs-actual breakdown. Same "validate free-form AI output against a
      // known set" precedent as feasibility-check.js's verdict whitelist.
      const normalized = {};
      for (const a of bp.categoryAllocations) {
        const key = normalizeFinanceCategory(a.category);
        normalized[key] = (normalized[key] || 0) + (Number(a.amount) || 0);
      }
      const orderedAllocations = FINANCE_CATEGORY_ORDER.filter(c => normalized[c] != null).map(c => ({ category: c, amount: normalized[c] }));
      const allocData = { allocations: orderedAllocations, debtPayoffPlan: bp.debtPayoffPlan || null };
      const existingAlloc = await sql`SELECT id FROM metric_logs WHERE user_id = ${user.id} AND log_type = 'category_allocations' LIMIT 1`;
      if (existingAlloc.length) {
        await sql`UPDATE metric_logs SET data = ${JSON.stringify(allocData)}::jsonb WHERE id = ${existingAlloc[0].id}`;
      } else {
        await sql`INSERT INTO metric_logs (user_id, pillar_id, log_type, data) VALUES (${user.id}, ${pillar_id}, 'category_allocations', ${JSON.stringify(allocData)}::jsonb)`;
      }
    }

    if (bp.savingsGoal?.name && Number(bp.savingsGoal.target) > 0) {
      await sql`
        INSERT INTO metric_logs (user_id, pillar_id, log_type, value, unit, data)
        VALUES (${user.id}, ${pillar_id}, 'savings_goal', ${Number(bp.savingsGoal.target)}, 'usd', ${JSON.stringify({ name: bp.savingsGoal.name, current_amount: 0, source: 'goal' })}::jsonb)
      `;
    }
  }

  res.status(200).json({ data: { id: goal_id, pillar: pillar_name, type: goal_type, timelineType: timeline_type, endDate: end_date, firstStep, ...plan } });
}

// Grocery List is a single metric_logs row (log_type='grocery_list', data.items=[...]) --
// same "one flexible row" pattern as everything else in this table, so no new schema/table
// is needed for a per-user list. Dedupes by lowercased name so re-adding the same
// ingredient from a second meal plan doesn't create a duplicate line item.
async function mergeIntoGroceryList(sql, userId, pillarId, ingredients) {
  const rows = await sql`SELECT * FROM metric_logs WHERE user_id = ${userId} AND log_type = 'grocery_list' LIMIT 1`;
  const existing = rows[0];
  const items = existing?.data?.items || [];
  const existingNames = new Set(items.map(i => String(i.name || '').toLowerCase()));
  for (const ing of ingredients) {
    const nameLower = String(ing.name).toLowerCase();
    if (existingNames.has(nameLower)) continue;
    items.push({ name: ing.name, qty: ing.qty || '', done: false, source: 'meal_plan' });
    existingNames.add(nameLower);
  }
  if (existing) {
    await sql`UPDATE metric_logs SET data = ${JSON.stringify({ items })}::jsonb WHERE id = ${existing.id}`;
  } else {
    await sql`INSERT INTO metric_logs (user_id, pillar_id, log_type, data) VALUES (${userId}, ${pillarId}, 'grocery_list', ${JSON.stringify({ items })}::jsonb)`;
  }
}

// GET /api/goals lists goals; POST /api/goals/generate (rewritten to ?action=generate) creates one.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  if (req.method === 'GET') return listGoals(req, res, user);
  if (req.method === 'POST') return generateGoal(req, res, user);
  res.status(405).json({ message: 'Method not allowed' });
}

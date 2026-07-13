import { sql, PILLARS, pillarIdFromName } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

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

const GOAL_TYPES = new Set(['habit', 'project', 'skill', 'mindset']);

function serialize(g) {
  return {
    id: g.id,
    pillar: PILLARS[g.pillar_id] || null,
    type: g.type,
    title: g.title,
    goal: g.title,
    why: g.why,
    timeline: g.timeline,
    dailyAnchor: g.daily_anchor,
    phases: g.phases,
    milestones: g.milestones,
    alts: g.alts,
    difficulty: g.difficulty,
    created_at: g.created_at,
  };
}

async function listGoals(req, res, user) {
  const pillar_id = req.query.pillar_id ? Number(req.query.pillar_id) : null;
  const rows = pillar_id
    ? await sql`SELECT * FROM goals WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} ORDER BY created_at DESC LIMIT 1`
    : await sql`SELECT * FROM goals WHERE user_id = ${user.id} ORDER BY created_at DESC`;
  res.status(200).json({ data: rows.map(serialize) });
}

// Pulls the Map of You reading into plan generation -- the archetype/edge/gap for this
// specific pillar, so a goal is grounded in the person's actual values, not just the
// questionnaire. Personal benefits most (mindset/identity work), but every pillar gets it.
function valueprintContext(valueprint_data, pillar_name) {
  if (!valueprint_data) return null;
  const gapEntry = Array.isArray(valueprint_data.gap)
    ? valueprint_data.gap.find(g => (g?.pillar || '').toLowerCase() === pillar_name.toLowerCase())
    : null;
  const lines = [
    valueprint_data.archetype ? `Archetype: ${valueprint_data.archetype}` : null,
    valueprint_data.oneLiner ? `Who they're becoming: ${valueprint_data.oneLiner}` : null,
    valueprint_data.edge ? `Their growth edge: ${valueprint_data.edge}` : null,
    gapEntry ? `${pillar_name} alignment right now: ${gapEntry.alignmentPct}% — ${gapEntry.note || ''}` : null,
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

  if (!pillar_name || !user_goal) {
    return res.status(422).json({ message: 'Validation failed', errors: { user_goal: ['pillar_name and (user_goal or questionnaire_answers) are required.'] } });
  }

  // Cost backstop: nobody legitimately needs unlimited plan regenerations in a day —
  // this is a cap against runaway loops/bugs, not a real usage limit.
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM goals WHERE user_id = ${user.id} AND created_at > now() - interval '1 day'`;
  if (count >= 20) {
    return res.status(429).json({ message: 'Too many plans generated today — try again tomorrow.' });
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
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2400,
          temperature: 0.4,
          system: [
            SYSTEM,
            PILLAR_PRINCIPLES[pillar_name.toLowerCase()],
            pillar_name.toLowerCase() === 'fitness' ? FITNESS_ADDENDUM : null,
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
      const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
      const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
      if (parsed.title) plan = { ...plan, ...parsed };
    } catch (e) {
      // fall back to the default plan above
    }
  }

  const pillar_id = pillarIdFromName(pillar_name);
  const goalRows = await sql`
    INSERT INTO goals (user_id, pillar_id, type, title, why, timeline, daily_anchor, phases, milestones, alts, difficulty)
    VALUES (${user.id}, ${pillar_id}, ${goal_type}, ${plan.title}, ${plan.why || null}, ${plan.timeline || null},
            ${plan.dailyAnchor || null}, ${JSON.stringify(plan.phases || [])}::jsonb,
            ${JSON.stringify(plan.milestones || [])}::jsonb, ${JSON.stringify(plan.alts || [])}::jsonb, ${goal_difficulty})
    RETURNING id
  `;
  const goal_id = goalRows[0].id;

  const today = new Date().toISOString().split('T')[0];
  if (goal_type === 'habit' || goal_type === 'mindset') {
    if (plan.dailyAnchor) {
      await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, recurrence, due_date, estimated_duration_minutes)
        VALUES (${user.id}, ${goal_id}, ${pillar_id}, ${plan.dailyAnchor}, 'habit', 'daily', ${today}, 15)
      `;
    }
  } else {
    // A project/skill goal becomes one real parent Project (kind='project', the thing
    // that shows up as a single "ProjectTask" block on the schedule) with its phase
    // actions as real sub-tasks (parent_task_id), not a handful of disconnected rows.
    const phases = plan.phases || [];
    const allActions = [];
    phases.forEach(ph => (ph.actions || []).forEach(a => allActions.push({ text: a, phaseLabel: ph.label || null })));

    if (allActions.length) {
      const subtaskMinutes = 30;
      const parentRows = await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, due_date, estimated_duration_minutes)
        VALUES (${user.id}, ${goal_id}, ${pillar_id}, ${plan.title}, 'project', ${today}, ${allActions.length * subtaskMinutes})
        RETURNING id
      `;
      const parent_task_id = parentRows[0].id;

      for (const action of allActions) {
        await sql`
          INSERT INTO tasks (user_id, goal_id, pillar_id, parent_task_id, name, kind, phase_label, estimated_duration_minutes)
          VALUES (${user.id}, ${goal_id}, ${pillar_id}, ${parent_task_id}, ${action.text}, 'simple', ${action.phaseLabel}, ${subtaskMinutes})
        `;
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

  res.status(200).json({ data: { id: goal_id, pillar: pillar_name, type: goal_type, ...plan } });
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

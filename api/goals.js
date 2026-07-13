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
If a Valueprint reading is provided (archetype, growth edge, pillar alignment), ground the "why" in it specifically — reference their actual edge or alignment gap, not generic encouragement.`;

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
          max_tokens: 1800,
          temperature: 0.4,
          system: SYSTEM,
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
    const firstPhase = (plan.phases || [])[0];
    for (const action of (firstPhase?.actions || []).slice(0, 3)) {
      await sql`
        INSERT INTO tasks (user_id, goal_id, pillar_id, name, kind, phase_label, due_date, estimated_duration_minutes)
        VALUES (${user.id}, ${goal_id}, ${pillar_id}, ${action}, 'project', ${firstPhase?.label || null}, ${today}, 30)
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

import { sql, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { getPillarState, buildPillarStates } from '../../lib/pillarState.js';
import { computeStreakDays } from '../../lib/tasks.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const UPSELL_MESSAGE = "That's a great question! Answering that requires analyzing your AI-powered plan, which is a Premium feature. Would you like to learn more?";

const TOOLS = [
  {
    name: 'get_schedule',
    description: "Get the user's real task schedule for a given date.",
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD, defaults to today if omitted' } },
    },
  },
  {
    name: 'create_simple_task',
    description: "Add a new simple task to the user's to-do list/schedule.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        pillar: { type: 'string', description: 'One of Fitness, Diet, Finances, Relations, Personal, Work -- optional' },
        estimatedDurationMinutes: { type: 'number' },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Urgent'] },
        dueDate: { type: 'string', description: 'YYYY-MM-DD, optional' },
        dueTime: { type: 'string', description: 'HH:MM, optional' },
      },
      required: ['name', 'estimatedDurationMinutes'],
    },
  },
];

async function runTool(sql, user, toolUse) {
  const today = new Date().toISOString().split('T')[0];
  if (toolUse.name === 'get_schedule') {
    const dateStr = toolUse.input.date || today;
    const rows = await sql`
      SELECT name, due_date, start_time, estimated_duration_minutes, priority, status FROM tasks
      WHERE user_id = ${user.id} AND due_date = ${dateStr} AND status != 'Skipped'
      ORDER BY start_time ASC NULLS LAST, created_at ASC
    `;
    return { result: JSON.stringify(rows), action_taken: null };
  }
  if (toolUse.name === 'create_simple_task') {
    const { name, pillar, estimatedDurationMinutes, priority, dueDate, dueTime } = toolUse.input;
    const pillar_id = pillar ? pillarIdFromName(pillar) : null;
    const rows = await sql`
      INSERT INTO tasks (user_id, name, pillar_id, estimated_duration_minutes, priority, due_date, start_time, kind)
      VALUES (${user.id}, ${name}, ${pillar_id}, ${estimatedDurationMinutes || 30}, ${priority || 'Medium'}, ${dueDate || null}, ${dueTime || null}, 'simple')
      RETURNING *
    `;
    return { result: JSON.stringify({ created: true, task: rows[0] }), action_taken: 'task_created' };
  }
  return { result: JSON.stringify({ error: 'Unknown tool' }), action_taken: null };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { message, conversation_history } = req.body || {};
  if (!message) return res.status(422).json({ message: 'message is required' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(200).json({ response_text: "I'm not able to respond right now -- try again shortly.", action_taken: null });

  const isPremium = user.subscription_tier === 'premium';
  const today = new Date().toISOString().split('T')[0];

  // Ground the assistant in the user's real data, not invented context.
  const pillarState = await getPillarState(user);
  const pillarStates = buildPillarStates(pillarState, user.recommended_pillar);
  const streakDays = await computeStreakDays(sql, user);
  const todayTasks = await sql`
    SELECT name, priority, status FROM tasks
    WHERE user_id = ${user.id} AND due_date = ${today} AND status != 'Skipped'
    ORDER BY start_time ASC NULLS LAST LIMIT 10
  `;

  const system = [
    `You are the PTW AI Assistant inside the "Plan To Win" app. Be warm, concise, and encouraging.`,
    `Real user data -- always ground answers in this, never invent numbers or tasks:`,
    `- Current phase: ${user.phase || 'unknown'}, XP: ${user.xp || 0}, daily streak: ${streakDays} days.`,
    `- Pillar states: ${pillarStates.map(p => `${p.pillarName}=${p.status}`).join(', ')}.`,
    `- Today's tasks: ${todayTasks.length ? todayTasks.map(t => `${t.name} (${t.priority}, ${t.status})`).join('; ') : 'nothing scheduled yet'}.`,
    `Account tier: ${isPremium ? 'premium' : 'free'}.`,
    `If the user asks for something that requires premium AI planning (e.g. "create a workout plan for me", "how should I invest $X", "plan my whole week") and the account tier is free, do NOT call any tool and do NOT attempt the request -- respond with exactly this line and nothing else: "${UPSELL_MESSAGE}"`,
  ].join('\n');

  const history = Array.isArray(conversation_history) ? conversation_history : [];
  const messages = [...history, { role: 'user', content: message }];

  try {
    const r1 = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system, tools: TOOLS, messages }),
    });
    const data1 = await r1.json();

    let action_taken = null;
    let finalContent = data1.content || [];

    const toolUse = (data1.content || []).find(b => b.type === 'tool_use');
    if (data1.stop_reason === 'tool_use' && toolUse) {
      const { result, action_taken: taken } = await runTool(sql, user, toolUse);
      action_taken = taken;
      messages.push({ role: 'assistant', content: data1.content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result }] });

      const r2 = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system, tools: TOOLS, messages }),
      });
      const data2 = await r2.json();
      finalContent = data2.content || [];
    }

    const response_text = finalContent.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || "Okay, done!";

    res.status(200).json({ response_text, action_taken });
  } catch (e) {
    res.status(200).json({ response_text: "Something went wrong on my end -- try again in a moment.", action_taken: null });
  }
}

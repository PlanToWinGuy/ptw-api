import { sql, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You create a personalized "Side Quest" for someone inside the Plan To Win app, from a free-form prompt about a specific pillar.

If the prompt describes wanting to STOP, QUIT, or REDUCE a habit (e.g. "stop smoking", "quit procrastinating", "reduce junk food", "cut down on drinking") -- this is an "Anti-Goal". For an Anti-Goal:
- If no baseline value has been given yet (see "Current baseline" in the user message), respond ONLY with this JSON and nothing else: {"needsBaseline": true, "baselineQuestion": "<a warm, natural question asking for their current baseline, e.g. how many cigarettes they typically smoke per day>"}
- If a baseline IS given, decide whether it is simplest tracked as "binary" (a yes/no daily action, e.g. "no phone in bed") or "progressive" (a numeric count that should gradually reduce, e.g. cigarettes per day). Return ONLY this JSON:
{"title": "<quest title>", "aiStrategy": "<1-2 sentences on why this approach helps>", "rewards": {"xp": <number 200-600>, "badgeName": "<short badge name or null>"}, "endDate": "<YYYY-MM-DD, realistic 2-6 weeks from today>", "antiGoalType": "binary" | "progressive", "baselineValue": <number, only for progressive>, "targetValue": <number, the FINAL target after the full reduction period, only for progressive>}

Otherwise, for a normal positive-framed Side Quest, return ONLY this JSON:
{"title": "<quest title>", "aiStrategy": "<1-2 sentences on why this quest complements their goals>", "rewards": {"xp": <number 150-600>, "badgeName": "<short badge name or null>"}, "endDate": "<YYYY-MM-DD, realistic for the quest's scope>", "projects": [{"projectName": "<phase name>", "subTasks": [{"name": "<specific, concrete action>"}]}]}
2-3 projects, 3-8 subtasks each, concrete and specific -- not vague filler.
Return ONLY the JSON, no markdown fences, no extra commentary.`;

function fallbackQuest(prompt) {
  return {
    title: prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt,
    aiStrategy: `A focused quest built around what you asked for.`,
    rewards: { xp: 200, badgeName: null },
    endDate: new Date(Date.now() + 21 * 86400000).toISOString().split('T')[0],
    projects: [{ projectName: 'Getting Started', subTasks: [{ name: `Work on: ${prompt}` }] }],
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { pillar, prompt, baseline } = req.body || {};
  if (!pillar || !prompt) return res.status(422).json({ message: 'pillar and prompt are required' });
  const pillar_id = pillarIdFromName(pillar);

  const key = process.env.ANTHROPIC_API_KEY;
  let parsed = null;

  if (key) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1400,
          temperature: 0.5,
          system: SYSTEM,
          messages: [{ role: 'user', content: `Pillar: ${pillar}\nPrompt: ${prompt}` + (baseline ? `\nCurrent baseline: ${baseline}` : '') }],
        }),
      });
      const data = await r.json();
      const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
      parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    } catch (e) {
      parsed = null;
    }
  }

  if (parsed?.needsBaseline) {
    return res.status(200).json({ needsBaseline: true, baselineQuestion: parsed.baselineQuestion });
  }
  if (!parsed?.title) parsed = fallbackQuest(prompt);

  const rows = await sql`
    INSERT INTO side_quests (user_id, pillar_id, status, original_prompt, draft_data, is_anti_goal)
    VALUES (${user.id}, ${pillar_id}, 'draft', ${prompt}, ${JSON.stringify(parsed)}::jsonb, ${!!parsed.antiGoalType})
    RETURNING id
  `;

  res.status(200).json({ reviewQuestId: rows[0].id, questData: parsed });
}

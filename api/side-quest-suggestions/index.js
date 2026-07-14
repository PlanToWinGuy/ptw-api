import { sql, PILLARS, pillarIdFromName } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Starter quest library per pillar -- the fallback used when there's no AI key, no
// active goal to personalize against, or the AI call fails for any reason.
const QUEST_LIBRARY = {
  Fitness:   [['30-day cold shower challenge', 'Build mental toughness', 120, 'Ice King', '5 min/day'], ['10k steps every day for a week', 'Movement habit', 80, 'Walker', 'Active']],
  Diet:      [['No processed sugar for 2 weeks', 'Reset your palette', 150, 'Clean Eater', '2 weeks'], ['Meal prep every Sunday', 'Consistency wins', 60, 'Prepper', '1h/week']],
  Finances:  [['Track every expense for 30 days', 'Financial awareness', 100, 'Tracker', '30 days'], ['No impulse purchases for 2 weeks', 'Intentional spending', 120, 'Intentional', '2 weeks']],
  Relations: [['Call someone important every day for a week', 'Stay connected', 80, 'Connector', '7 days']],
  Personal:  [['Read 20 pages every day', 'Knowledge compounds', 80, 'Scholar', '30 min/day'], ['Daily journaling', 'Clarity through writing', 50, 'Writer', '10 min/day']],
  Work:      [['1 hour of deep work before checking phone', 'Protect your attention', 100, 'Focused', 'Daily']],
};

const SYSTEM = `You suggest short, motivating Side Quests for someone's stated pillar, grounded in their real active goal. Return ONLY JSON, an array of 2-3 quests:
[{"title": "<short quest name>", "description": "<1 sentence>", "durationCategory": "This Week" | "This Month" | "Long-Term", "xp": <number 50-300>, "badgeName": "<short badge name or null>"}]
Quests should complement the stated goal (not duplicate it exactly) -- a focused side-challenge, not the main plan itself.`;

async function generateAISuggestions(pillarName, goal) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        temperature: 0.5,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Pillar: ${pillarName}\nActive goal: ${goal.title}\nGoal why: ${goal.why || ''}` }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillar_id = req.query.pillar_id ? Number(req.query.pillar_id) : pillarIdFromName(req.query.pillar);
  if (!pillar_id) return res.status(422).json({ message: 'pillar_id or pillar is required' });

  const existing = await sql`SELECT * FROM side_quests WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND status != 'draft'`;
  if (!existing.length) {
    const pillarName = PILLARS[pillar_id];
    const [goal] = await sql`SELECT * FROM goals WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} ORDER BY created_at DESC LIMIT 1`;
    const aiSuggestions = goal ? await generateAISuggestions(pillarName, goal) : null;

    if (aiSuggestions) {
      for (const s of aiSuggestions) {
        await sql`
          INSERT INTO side_quests (user_id, pillar_id, suggestion, description, xp, badge_name, duration_category)
          VALUES (${user.id}, ${pillar_id}, ${s.title}, ${s.description || null}, ${s.xp || 100}, ${s.badgeName || null}, ${s.durationCategory || null})
        `;
      }
    } else {
      const library = QUEST_LIBRARY[pillarName] || [];
      for (const [suggestion, description, xp, badge_name, duration_category] of library) {
        await sql`
          INSERT INTO side_quests (user_id, pillar_id, suggestion, description, xp, badge_name, duration_category)
          VALUES (${user.id}, ${pillar_id}, ${suggestion}, ${description}, ${xp}, ${badge_name}, ${duration_category})
        `;
      }
    }
  }

  const rows = existing.length ? existing : await sql`SELECT * FROM side_quests WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND status != 'draft'`;

  // Complex Quest Cards (custom-generated, with linked projects) route to the Side
  // Quest Detail Page instead of the plain inline Start/Done button.
  const projectCounts = rows.length
    ? await sql`SELECT quest_id, COUNT(*)::int AS count FROM tasks WHERE quest_id = ANY(${rows.map(r => r.id)}) AND kind = 'project' GROUP BY quest_id`
    : [];
  const countsByQuest = Object.fromEntries(projectCounts.map(r => [r.quest_id, r.count]));

  res.status(200).json(rows.map(r => ({ ...r, has_projects: (countsByQuest[r.id] || 0) > 0 })));
}

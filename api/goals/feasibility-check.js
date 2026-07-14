import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// 2.9.3 -- runs before generation, on the raw goal/questionnaire answers, not an
// already-generated plan: this app doesn't hold goals in a draft state the way custom
// Side Quests do, so checking feasibility has to happen before the user commits to a
// Strict deadline rather than after a plan is already saved.
const SYSTEM = `You judge whether a goal is realistically achievable by a specific deadline. Return ONLY JSON:
{"verdict": "confirm" | "warn" | "reject", "message": "<1-2 sentences, second person, honest and specific>"}
confirm: the deadline is realistic and healthy for this goal.
warn: achievable but aggressive/demanding -- say plainly what it will require.
reject: unrealistic or unhealthy for this timeframe (e.g. a significant body-composition or debt goal compressed into days instead of weeks/months) -- explain why and suggest a more realistic timeframe.`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { pillar_name, user_goal, questionnaire_answers, target_end_date } = req.body || {};
  if (!pillar_name || !target_end_date) {
    return res.status(422).json({ message: 'Validation failed', errors: { target_end_date: ['pillar_name and target_end_date are required.'] } });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  // Fail open (confirm) when the AI is unavailable -- same fallback-on-error precedent
  // as api/goals.js's own generation call. A feasibility check that can't run shouldn't
  // block someone from setting a deadline.
  if (!key) return res.status(200).json({ verdict: 'confirm', message: '' });

  const today = new Date().toISOString().split('T')[0];
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        temperature: 0.3,
        system: SYSTEM,
        messages: [{ role: 'user', content: [
          `Pillar: ${pillar_name}`,
          `Goal: ${user_goal || '(see questionnaire answers below)'}`,
          questionnaire_answers ? `Questionnaire answers: ${JSON.stringify(questionnaire_answers)}` : null,
          `Today: ${today}`,
          `Requested deadline: ${target_end_date}`,
        ].filter(Boolean).join('\n') }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    const verdict = ['confirm', 'warn', 'reject'].includes(parsed.verdict) ? parsed.verdict : 'confirm';
    return res.status(200).json({ verdict, message: parsed.message || '' });
  } catch (e) {
    return res.status(200).json({ verdict: 'confirm', message: '' });
  }
}

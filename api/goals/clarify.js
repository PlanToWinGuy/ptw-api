import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Runs once, right after the activation questionnaire and before plan generation --
// most submissions have enough detail already (a filled-out questionnaire is usually
// specific enough), so this only surfaces friction for the genuinely ambiguous ones
// (e.g. a vague free-text goal, or an answer set with an internal contradiction) rather
// than adding a mandatory extra step for every single activation.
const SYSTEM = `You decide whether a fitness/diet/finance/etc. goal submission has enough detail to build a truly personalized plan, or whether it's genuinely ambiguous and a couple of quick follow-up questions would meaningfully improve the plan. Return ONLY JSON:
{"needsClarification": true|false, "questions": ["<question 1>", "<question 2>"]}
needsClarification should be false for the common case -- a filled-out questionnaire with a reasonably specific goal needs no follow-up. Only set it true when something genuinely blocks building a good plan: a vague/generic free-text goal ("get better", "be healthier"), a real contradiction between answers (e.g. "no equipment" but goal requires a barbell lift), or a significant quantifiable goal with no starting point given.
questions: at most 2, short, second person, each answerable in one sentence. Empty array if needsClarification is false.`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { pillar_name, user_goal, questionnaire_answers } = req.body || {};
  if (!pillar_name) return res.status(422).json({ message: 'Validation failed', errors: { pillar_name: ['pillar_name is required.'] } });

  const key = process.env.ANTHROPIC_API_KEY;
  // Fail open (no clarification) when the AI is unavailable -- a step meant to improve
  // the plan shouldn't be able to block someone from getting one at all.
  if (!key) return res.status(200).json({ needsClarification: false, questions: [] });

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
        ].filter(Boolean).join('\n') }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 2).filter(q => typeof q === 'string' && q.trim()) : [];
    return res.status(200).json({ needsClarification: !!parsed.needsClarification && questions.length > 0, questions });
  } catch (e) {
    console.error('goals.clarify: AI call failed, skipping clarification', { pillar_name, user_id: user.id, error: String(e) });
    return res.status(200).json({ needsClarification: false, questions: [] });
  }
}

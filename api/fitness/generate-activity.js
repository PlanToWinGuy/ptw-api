import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// "Start Spontaneous Activity" used to require manually filling in exercise rows/sets/
// reps by hand even for a one-off freeform activity someone just typed a name for --
// nothing like a real fitness app's "type it, get a workout" search. This turns a short
// query ("shoulder HIIT", "20 min upper body", "morning yoga flow") into a real,
// ready-to-start plan in the exact same shape the manual template form already saves,
// so the rest of the flow (startWorkout/finishWorkout) needs zero changes to use it.
const SYSTEM = `You turn a short activity description into a real, ready-to-do workout plan. Return ONLY JSON, no prose, matching exactly one of these shapes based on which activityType best fits the request:

Strength: {"name": "<short plan name>", "activityType": "strength", "exercises": [{"name": "<exercise>", "sets": <number>, "targetReps": <number>, "targetWeight": <number, 0 if bodyweight>}]}
Cardio: {"name": "<short plan name>", "activityType": "cardio", "durationMin": <number>, "distance": <number, 0 if not distance-based>, "intensity": "Easy"|"Moderate"|"Hard"}
HIIT: {"name": "<short plan name>", "activityType": "hiit", "rounds": <number>, "workSeconds": <number>, "restSeconds": <number>}
Mobility: {"name": "<short plan name>", "activityType": "mobility", "durationMin": <number>, "stretches": ["<pose/stretch name>", ...]}

Pick whichever type genuinely fits what they described -- "shoulder HIIT" is hiit with shoulder-focused work implied by the plan name and a sensible round count, "morning yoga flow" is mobility with 5-8 real named poses, "squash" or "a run" is cardio, "upper body day" is strength with 4-6 real exercises. Keep it realistic and ready to actually do -- real exercise/pose names, sensible defaults (strength: 3 sets of 8-12 reps unless the request implies otherwise; HIIT: 6-10 rounds of 20-40s work; mobility: 30-45s per pose feel, 5-8 poses; cardio: 15-30 min). If the request is too vague to build anything real from, still make a reasonable best-effort plan -- never return an error or ask a follow-up question.`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const { query } = req.body || {};
  if (!query || !String(query).trim()) {
    return res.status(422).json({ message: 'Validation failed', errors: { query: ['query is required.'] } });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ message: 'ANTHROPIC_API_KEY not set on the server' });

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        temperature: 0.4,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Activity: "${String(query).trim()}"` }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    if (!parsed.activityType || !parsed.name) throw new Error('Malformed plan from model');
    res.status(200).json({ data: parsed });
  } catch (e) {
    console.error('fitness.generate-activity: AI call failed', { query, user_id: user.id, error: String(e) });
    res.status(500).json({ message: "Couldn't generate a workout for that -- try rephrasing, or fill it in manually." });
  }
}

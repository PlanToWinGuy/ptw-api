import { sql } from '../../../lib/db.js';
import { cors } from '../../../lib/cors.js';
import { getUserFromRequest } from '../../../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You are revising a previously-generated "Side Quest" plan based on the user's refinement instructions. You will be given the original prompt, the current generated plan (as JSON), and a new refinement instruction. Return ONLY the revised plan as JSON, in the exact same shape as the current plan you were given (same top-level keys: title, aiStrategy, rewards, endDate, and either "projects" or the anti-goal fields "antiGoalType"/"baselineValue"/"targetValue" -- keep whichever shape the current plan already uses). No markdown fences, no commentary.`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const { refinement_prompt } = req.body || {};
  if (!refinement_prompt) return res.status(422).json({ message: 'refinement_prompt is required' });

  const rows = await sql`SELECT * FROM side_quests WHERE id = ${id} AND user_id = ${user.id} AND status = 'draft'`;
  const draft = rows[0];
  if (!draft) return res.status(404).json({ message: 'Draft quest not found' });

  const key = process.env.ANTHROPIC_API_KEY;
  let parsed = draft.draft_data;

  if (key) {
    try {
      // Same truncation fix as custom.js -- 1400 was too tight for a full revised
      // multi-project plan and could silently fall back to the un-refined draft.
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          temperature: 0.5,
          system: SYSTEM,
          messages: [{ role: 'user', content: `Original prompt: ${draft.original_prompt}\nCurrent plan: ${JSON.stringify(draft.draft_data)}\nRefinement instruction: ${refinement_prompt}` }],
        }),
      });
      const data = await r.json();
      if (data.stop_reason === 'max_tokens') {
        console.error('side-quests.refine: response truncated at max_tokens', { id, user_id: user.id });
      }
      const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
      const revised = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
      if (revised?.title) parsed = revised;
    } catch (e) {
      // fall back to the existing draft_data if refinement fails
    }
  }

  await sql`UPDATE side_quests SET draft_data = ${JSON.stringify(parsed)}::jsonb WHERE id = ${id}`;
  res.status(200).json({ reviewQuestId: id, questData: parsed });
}

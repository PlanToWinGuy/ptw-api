import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

// Starter quest library per pillar — seeded into the user's own side_quests rows
// the first time they open a pillar's quest tab, so activate/complete have real rows to update.
const QUEST_LIBRARY = {
  Fitness:   [['30-day cold shower challenge', 'Build mental toughness', 120, 'Ice King', '5 min/day'], ['10k steps every day for a week', 'Movement habit', 80, 'Walker', 'Active']],
  Diet:      [['No processed sugar for 2 weeks', 'Reset your palette', 150, 'Clean Eater', '2 weeks'], ['Meal prep every Sunday', 'Consistency wins', 60, 'Prepper', '1h/week']],
  Finances:  [['Track every expense for 30 days', 'Financial awareness', 100, 'Tracker', '30 days'], ['No impulse purchases for 2 weeks', 'Intentional spending', 120, 'Intentional', '2 weeks']],
  Relations: [['Call someone important every day for a week', 'Stay connected', 80, 'Connector', '7 days']],
  Personal:  [['Read 20 pages every day', 'Knowledge compounds', 80, 'Scholar', '30 min/day'], ['Daily journaling', 'Clarity through writing', 50, 'Writer', '10 min/day']],
  Work:      [['1 hour of deep work before checking phone', 'Protect your attention', 100, 'Focused', 'Daily']],
};

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillar_id = Number(req.query.pillar_id);
  if (!pillar_id) return res.status(422).json({ message: 'pillar_id is required' });

  const existing = await sql`SELECT * FROM side_quests WHERE user_id = ${user.id} AND pillar_id = ${pillar_id}`;
  if (!existing.length) {
    const library = QUEST_LIBRARY[PILLARS[pillar_id]] || [];
    for (const [suggestion, description, xp, badge_name, duration_category] of library) {
      await sql`
        INSERT INTO side_quests (user_id, pillar_id, suggestion, description, xp, badge_name, duration_category)
        VALUES (${user.id}, ${pillar_id}, ${suggestion}, ${description}, ${xp}, ${badge_name}, ${duration_category})
      `;
    }
  }

  const rows = existing.length ? existing : await sql`SELECT * FROM side_quests WHERE user_id = ${user.id} AND pillar_id = ${pillar_id}`;
  res.status(200).json(rows);
}

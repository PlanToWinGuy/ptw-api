import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

// Simple deterministic rules engine (4.17.C) -- a task's pillar maps to a curated,
// non-distracting set of external-utility deep links. No AI call needed: this is a
// fixed lookup table, not a judgment call worth spending on a live model for.
const APPS_BY_PILLAR = {
  Work:      [{ appName: 'Mail', iconName: 'mail_icon', urlScheme: 'mailto:' }, { appName: 'Calendar', iconName: 'calendar_icon', urlScheme: 'calshow://' }, { appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }],
  Fitness:   [{ appName: 'Spotify', iconName: 'spotify_icon', urlScheme: 'spotify:' }, { appName: 'Camera', iconName: 'camera_icon', urlScheme: '' }, { appName: 'Health', iconName: 'health_icon', urlScheme: 'x-apple-health://' }],
  Diet:      [{ appName: 'Camera', iconName: 'camera_icon', urlScheme: '' }, { appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }],
  Finances:  [{ appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }, { appName: 'Calculator', iconName: 'calculator_icon', urlScheme: 'calc://' }],
  Relations: [{ appName: 'Mail', iconName: 'mail_icon', urlScheme: 'mailto:' }, { appName: 'Calendar', iconName: 'calendar_icon', urlScheme: 'calshow://' }],
  Personal:  [{ appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }, { appName: 'Spotify', iconName: 'spotify_icon', urlScheme: 'spotify:' }],
};
const DEFAULT_APPS = [{ appName: 'Mail', iconName: 'mail_icon', urlScheme: 'mailto:' }, { appName: 'Calendar', iconName: 'calendar_icon', urlScheme: 'calshow://' }, { appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }, { appName: 'Spotify', iconName: 'spotify_icon', urlScheme: 'spotify:' }];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const taskId = req.query.taskId ? Number(req.query.taskId) : null;
  if (!taskId) return res.status(200).json({ apps: DEFAULT_APPS });

  const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id}`;
  const task = rows[0];
  const pillarName = task ? PILLARS[task.pillar_id] : null;

  res.status(200).json({ apps: APPS_BY_PILLAR[pillarName] || DEFAULT_APPS });
}

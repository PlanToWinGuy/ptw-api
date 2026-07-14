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

// Take a Break (4.14) integration -- reached mid-break instead of blindly reaching for
// whatever app is muscle-memory. Each break type gets its own curated set plus one
// habit-stack suggestion (a small, deterministic nudge toward a better use of the same
// downtime -- e.g. a language lesson instead of another scroll). Static rules, not an
// AI call, same cost-discipline precedent as APPS_BY_PILLAR above.
const APPS_BY_BREAK = {
  bathroom:     [{ appName: 'Duolingo', iconName: 'duolingo_icon', urlScheme: 'duolingo://' }, { appName: 'Podcasts', iconName: 'podcasts_icon', urlScheme: 'podcasts://' }],
  snack:        [{ appName: 'Spotify', iconName: 'spotify_icon', urlScheme: 'spotify:' }, { appName: 'Podcasts', iconName: 'podcasts_icon', urlScheme: 'podcasts://' }],
  stretch:      [{ appName: 'Spotify', iconName: 'spotify_icon', urlScheme: 'spotify:' }],
  walk:         [{ appName: 'Spotify', iconName: 'spotify_icon', urlScheme: 'spotify:' }, { appName: 'Podcasts', iconName: 'podcasts_icon', urlScheme: 'podcasts://' }],
  mental_reset: [{ appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }],
  free_time:    [{ appName: 'Duolingo', iconName: 'duolingo_icon', urlScheme: 'duolingo://' }, { appName: 'Mail', iconName: 'mail_icon', urlScheme: 'mailto:' }, { appName: 'Notes', iconName: 'notes_icon', urlScheme: 'mobilenotes://' }],
};
const HABIT_STACK_HINT = {
  bathroom:     'A quick Duolingo lesson pairs well with a bathroom break.',
  snack:        'Queue up a podcast while you eat.',
  walk:         'Good time for a podcast or a call.',
  free_time:    'One Duolingo lesson beats another scroll.',
};

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  if (req.method === 'POST') {
    // Tracking-only (no XP -- see api/metrics.js) -- which app someone actually reached
    // for during free time, so patterns can surface later (e.g. "you open Instagram
    // during 80% of your Free Time breaks").
    const { appName, context } = req.body || {};
    if (!appName) return res.status(422).json({ message: 'appName is required' });
    await sql`INSERT INTO metric_logs (user_id, log_type, data) VALUES (${user.id}, 'essential_app_launch', ${JSON.stringify({ appName, context: context || null })}::jsonb)`;
    return res.status(200).json({ message: 'logged' });
  }

  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const taskId = req.query.taskId ? Number(req.query.taskId) : null;
  const breakType = req.query.breakType || null;

  if (breakType) {
    return res.status(200).json({ apps: APPS_BY_BREAK[breakType] || DEFAULT_APPS, habitStack: HABIT_STACK_HINT[breakType] || null });
  }

  if (!taskId) return res.status(200).json({ apps: DEFAULT_APPS, habitStack: null });

  const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id}`;
  const task = rows[0];
  const pillarName = task ? PILLARS[task.pillar_id] : null;

  res.status(200).json({ apps: APPS_BY_PILLAR[pillarName] || DEFAULT_APPS, habitStack: null });
}

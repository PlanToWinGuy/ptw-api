import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// A real, expanded tool directory (4.17.C) -- curated per pillar, still a fixed table
// (no AI call for pillar/task/break lookups: same cost-discipline precedent as before),
// just a genuinely useful "range of options" instead of 2-3 items. Each entry carries:
//  - urlScheme: a native app deep link to try first, only for schemes already known-good
//    (kept from the original list, never guessed) -- omitted when no reliable scheme exists.
//  - webFallback: a real https:// URL that always works, used when the native scheme
//    doesn't open an app (most of these schemes are iOS-only and previously just failed
//    silently on Android/desktop with no fallback at all -- the actual "doesn't launch a
//    lot of things" bug).
//  - action: 'scan_food' replaces the old fake Camera entry (urlScheme:'', which could
//    never launch anything) with a real, working in-app camera pipeline -- this app
//    already has a genuine photo -> AI macro estimate flow built for Diet logging
//    (POST /metrics/scan-meal), so Essential Apps now routes straight into that instead
//    of pretending to hand off to a device Camera app a PWA can't actually control.
// category: 'utility' | 'entertainment' | 'skill' | 'wellness' -- lets the idle/
// nothing-scheduled case (no task, no break) pull specifically from entertainment+skill
// instead of quietly defaulting to the same utility set (Mail/Calendar/Notes) that makes
// sense mid-task but is dead weight during genuine free time.
const CATALOG = {
  mail:      { appName: 'Mail',      iconName: 'mail_icon',      category: 'utility',      urlScheme: 'mailto:',              webFallback: 'https://mail.google.com/mail/' },
  calendar:  { appName: 'Calendar',  iconName: 'calendar_icon',  category: 'utility',      urlScheme: 'calshow://',            webFallback: 'https://calendar.google.com/' },
  notes:     { appName: 'Notes',     iconName: 'notes_icon',     category: 'utility',      urlScheme: 'mobilenotes://',        webFallback: 'https://keep.google.com/' },
  spotify:   { appName: 'Spotify',   iconName: 'spotify_icon',   category: 'entertainment',urlScheme: 'spotify:',               webFallback: 'https://open.spotify.com/' },
  health:    { appName: 'Health',    iconName: 'health_icon',    category: 'wellness',     urlScheme: 'x-apple-health://' },
  calculator:{ appName: 'Calculator',iconName: 'calculator_icon',category: 'utility',      urlScheme: 'calc://' },
  duolingo:  { appName: 'Duolingo',  iconName: 'duolingo_icon',  category: 'skill',        urlScheme: 'duolingo://',            webFallback: 'https://www.duolingo.com/' },
  podcasts:  { appName: 'Podcasts',  iconName: 'podcasts_icon',  category: 'skill',        urlScheme: 'podcasts://' },
  strava:    { appName: 'Strava',    iconName: 'health_icon',    category: 'wellness',     webFallback: 'https://www.strava.com/' },
  slack:     { appName: 'Slack',     iconName: 'mail_icon',      category: 'utility',      urlScheme: 'slack://open',           webFallback: 'https://slack.com/' },
  zoom:      { appName: 'Zoom',      iconName: 'calendar_icon',  category: 'utility',      urlScheme: 'zoomus://',              webFallback: 'https://zoom.us/' },
  whatsapp:  { appName: 'WhatsApp',  iconName: 'mail_icon',      category: 'utility',      urlScheme: 'whatsapp://',            webFallback: 'https://web.whatsapp.com/' },
  scan_food: { appName: 'Scan Food', iconName: 'camera_icon',    category: 'utility',      action: 'scan_food' },
  youtube:   { appName: 'YouTube',   iconName: 'podcasts_icon',  category: 'entertainment',urlScheme: 'youtube://',             webFallback: 'https://www.youtube.com/' },
  netflix:   { appName: 'Netflix',   iconName: 'podcasts_icon',  category: 'entertainment',urlScheme: 'nflx://',                webFallback: 'https://www.netflix.com/' },
  kindle:    { appName: 'Kindle',    iconName: 'notes_icon',     category: 'skill',        urlScheme: 'kindle://',              webFallback: 'https://read.amazon.com/' },
  audible:   { appName: 'Audible',   iconName: 'podcasts_icon',  category: 'skill',        urlScheme: 'audible://',             webFallback: 'https://www.audible.com/' },
  brilliant: { appName: 'Brilliant', iconName: 'duolingo_icon',  category: 'skill',        webFallback: 'https://brilliant.org/' },
};

const APPS_BY_PILLAR = {
  Work:      ['mail', 'calendar', 'notes', 'slack', 'zoom'],
  Fitness:   ['spotify', 'scan_food', 'health', 'strava'],
  Diet:      ['scan_food', 'notes', 'spotify'],
  Finances:  ['notes', 'calculator'],
  Relations: ['mail', 'calendar', 'whatsapp'],
  Personal:  ['notes', 'spotify', 'duolingo'],
};
const DEFAULT_KEYS = ['mail', 'calendar', 'notes', 'spotify'];
// The "nothing scheduled right now" fallback (no AI key configured) -- a real mix of
// entertainment + skill-building instead of the task-context utility defaults above,
// since idle time isn't well served by "here's your Mail app again."
const IDLE_KEYS = ['duolingo', 'youtube', 'spotify', 'kindle'];

// tool_hint-level overrides layered on top of the pillar list, for the cases where the
// specific task matters more than the pillar overall (a meal-logging task always wants
// Scan Food first regardless of pillar; a workout wants music+health, not the Diet set).
const APPS_BY_TOOL_HINT = {
  meal:    ['scan_food', 'notes'],
  workout: ['spotify', 'health', 'strava'],
  weight:  ['health'],
  transaction: ['calculator', 'notes'],
};

function resolveApps(keys) {
  return keys.map(k => CATALOG[k]).filter(Boolean);
}

// A PWA has no API to see what's actually installed on the device, so "aware of apps
// on your device" has to mean something a user explicitly tells it, via Settings ->
// Preferred Quick-Add Apps (preferences scope 'essential_apps', { preferredKeys: [...] }).
// When set, whichever context's normal key list gets reordered so the user's own picks
// come first -- still shows the rest of the contextually-relevant set after them, rather
// than hard-filtering down to only their picks (which could empty out a task-specific
// drawer if none of their favorites happen to fit this particular context).
async function getPreferredKeys(sql, userId) {
  const rows = await sql`SELECT data FROM preferences WHERE user_id = ${userId} AND scope = 'essential_apps'`;
  const keys = rows[0]?.data?.preferredKeys;
  return Array.isArray(keys) ? keys.filter(k => CATALOG[k]) : [];
}
function prioritize(keys, preferredKeys) {
  if (!preferredKeys.length) return keys;
  const preferredSet = new Set(preferredKeys);
  return [...keys.filter(k => preferredSet.has(k)), ...keys.filter(k => !preferredSet.has(k))];
}

const APPS_BY_BREAK = {
  bathroom:     ['duolingo', 'podcasts'],
  snack:        ['spotify', 'podcasts', 'scan_food'],
  stretch:      ['spotify'],
  walk:         ['spotify', 'podcasts'],
  mental_reset: ['notes'],
  free_time:    ['duolingo', 'mail', 'notes'],
};
const HABIT_STACK_HINT = {
  bathroom:     'A quick Duolingo lesson pairs well with a bathroom break.',
  snack:        'Queue up a podcast while you eat.',
  walk:         'Good time for a podcast or a call.',
  free_time:    'One Duolingo lesson beats another scroll.',
};

const SUGGEST_SYSTEM = `You suggest 4 tools from a fixed catalog for someone opening a general "quick tools" drawer in a life-coaching app, with no specific task selected. Pick tools genuinely useful for their current moment (time of day, what's next on their schedule) -- not random. If nothing is currently scheduled (genuine free/idle time), favor a real mix of entertainment and skill-building tools over plain utilities like Mail or Calendar, so downtime feels enriching rather than filler. If the person has told you which apps they actually use/prefer, weight picks toward those first. Return ONLY JSON: {"picks": [{"key": "<catalog key>", "reason": "<max 10 words, why this one right now>"}]}. Pick exactly 4, all keys must come from the provided catalog list, never invent a key.`;

async function aiSuggest(catalogKeys, hour, nextTaskDesc, preferredKeys) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0.4,
        system: SUGGEST_SYSTEM,
        messages: [{ role: 'user', content:
          `Catalog keys: ${catalogKeys.join(', ')}\nCurrent hour (24h, server time): ${hour}\nNext scheduled task: ${nextTaskDesc || 'none scheduled -- genuine free time right now'}\nApps this person says they actually use: ${preferredKeys?.length ? preferredKeys.join(', ') : 'not specified'}`
        }],
      }),
    });
    const data = await r.json();
    const text = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const parsed = JSON.parse(text.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
    const picks = Array.isArray(parsed.picks) ? parsed.picks : [];
    // Validate: only accept keys that actually exist in our catalog -- the AI never
    // supplies a URL scheme or web address directly, only a choice from a known-safe set.
    return picks
      .filter(p => CATALOG[p.key])
      .map(p => ({ ...CATALOG[p.key], reason: typeof p.reason === 'string' ? p.reason.slice(0, 60) : null }));
  } catch (e) {
    console.error('essential-apps: AI suggest failed', String(e));
    return null;
  }
}

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
  const preferredKeys = await getPreferredKeys(sql, user.id);

  if (breakType) {
    const keys = prioritize(APPS_BY_BREAK[breakType] || DEFAULT_KEYS, preferredKeys);
    return res.status(200).json({ apps: resolveApps(keys), habitStack: HABIT_STACK_HINT[breakType] || null });
  }

  if (taskId) {
    const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id}`;
    const task = rows[0];
    const pillarName = task ? PILLARS[task.pillar_id] : null;
    const keys = prioritize((task?.tool_hint && APPS_BY_TOOL_HINT[task.tool_hint]) || APPS_BY_PILLAR[pillarName] || DEFAULT_KEYS, preferredKeys);
    return res.status(200).json({ apps: resolveApps(keys), habitStack: null });
  }

  // The "main Essential Apps folder" case -- opened straight from Home with no task or
  // break context, which in practice means genuinely idle/nothing-scheduled time. This
  // used to just return the same 4 static defaults every time, which is exactly what the
  // founder flagged as "hardly giving suggestions." A cheap Haiku call picks from the
  // real catalog based on time of day, what's actually next on the schedule, and this
  // person's own stated app preferences, favoring entertainment/skill-building over bare
  // utilities during real downtime. Falls back to a curated entertainment+skill set (not
  // the task-context utility defaults) if the AI call fails or no API key is set -- never
  // a broken/empty drawer, and never just "here's Mail again" during free time.
  const todayRows = await sql`
    SELECT name, pillar_id FROM tasks
    WHERE user_id = ${user.id} AND status = 'Pending' AND due_date = CURRENT_DATE
    ORDER BY start_time NULLS LAST LIMIT 1
  `.catch(() => []);
  const nextTask = todayRows[0];
  const nextTaskDesc = nextTask ? `${nextTask.name} (${PILLARS[nextTask.pillar_id] || 'general'})` : null;
  const hour = new Date().getUTCHours();
  const suggested = await aiSuggest(Object.keys(CATALOG), hour, nextTaskDesc, preferredKeys);
  if (suggested && suggested.length) return res.status(200).json({ apps: suggested, habitStack: null, aiSuggested: true });

  return res.status(200).json({ apps: resolveApps(prioritize(IDLE_KEYS, preferredKeys)), habitStack: null });
}

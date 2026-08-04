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
  maps:      { appName: 'Maps',      iconName: 'maps_icon',      category: 'utility',      urlScheme: 'maps://',                webFallback: 'https://maps.google.com/' },
  phone:     { appName: 'Phone',     iconName: 'phone_icon',     category: 'utility',      urlScheme: 'tel:' },
  // Real-world awareness (news/politics from multiple perspectives, bias-labeled) fits
  // the same "worth doing with idle time" slot as Duolingo/Brilliant -- staying informed
  // is a real skill-building/wellness activity, not just entertainment filler.
  ground_news: { appName: 'Ground News', iconName: 'news_icon',   category: 'skill',        webFallback: 'https://ground.news/' },

  // ── LIBRARY EXPANSION (4.19) ──────────────────────────────────────────────
  // Grows Essential Apps from a curated ~20-app suggestion set into a genuinely
  // browsable "open library" (see GET /essential-apps?library=1) with a search bar --
  // the product ask was "an open library and search bar... to find whatever they need
  // easy on device." Neither iOS nor Android lets a third-party app enumerate every app
  // actually installed on the device (iOS: canOpenURL only answers yes/no for schemes
  // YOU pre-declare, capped at 50, never "list everything"; Android: QUERY_ALL_PACKAGES
  // is gated behind Play Console's declared-use review for launcher/antivirus-class apps
  // and would put a general productivity app like this one at real risk of rejection).
  // So this grows the thing that's actually buildable: a large, well-organized, PTW-
  // curated catalog, same urlScheme-first/webFallback-always deep-link pattern as above.
  // New categories beyond the original utility/entertainment/skill/wellness: 'social',
  // 'productivity', 'finance', 'shopping', 'travel' -- real launcher-style groupings.
  // urlScheme is still only ever set when it's a long-standing, publicly documented
  // scheme (verified, not guessed) -- same discipline as the original list. Most of
  // these entries are webFallback-only, which is honest: it just means the native
  // scheme isn't confidently known-good, not that the app can't be reached at all --
  // launchEssentialApp() already opens webFallback directly whenever urlScheme is absent.
  instagram:  { appName: 'Instagram',  iconName: 'instagram_icon',  category: 'social',       urlScheme: 'instagram://',  webFallback: 'https://www.instagram.com/' },
  facebook:   { appName: 'Facebook',   iconName: 'facebook_icon',   category: 'social',       webFallback: 'https://www.facebook.com/' },
  twitter:    { appName: 'X',          iconName: 'twitter_icon',    category: 'social',       urlScheme: 'twitter://',    webFallback: 'https://x.com/' },
  tiktok:     { appName: 'TikTok',     iconName: 'tiktok_icon',     category: 'social',       webFallback: 'https://www.tiktok.com/' },
  snapchat:   { appName: 'Snapchat',   iconName: 'snapchat_icon',   category: 'social',       webFallback: 'https://www.snapchat.com/' },
  linkedin:   { appName: 'LinkedIn',   iconName: 'linkedin_icon',   category: 'social',       urlScheme: 'linkedin://',   webFallback: 'https://www.linkedin.com/' },
  reddit:     { appName: 'Reddit',     iconName: 'reddit_icon',     category: 'social',       webFallback: 'https://www.reddit.com/' },
  pinterest:  { appName: 'Pinterest',  iconName: 'pinterest_icon',  category: 'social',       webFallback: 'https://www.pinterest.com/' },
  telegram:   { appName: 'Telegram',   iconName: 'telegram_icon',   category: 'social',       urlScheme: 'tg://',         webFallback: 'https://web.telegram.org/' },
  discord:    { appName: 'Discord',    iconName: 'discord_icon',    category: 'social',       webFallback: 'https://discord.com/app' },

  notion:     { appName: 'Notion',     iconName: 'notion_icon',     category: 'productivity', webFallback: 'https://www.notion.so/' },
  todoist:    { appName: 'Todoist',    iconName: 'todoist_icon',    category: 'productivity', webFallback: 'https://todoist.com/app' },
  trello:     { appName: 'Trello',     iconName: 'trello_icon',     category: 'productivity', urlScheme: 'trello://',     webFallback: 'https://trello.com/' },
  teams:      { appName: 'Teams',      iconName: 'teams_icon',      category: 'productivity', webFallback: 'https://teams.microsoft.com/' },
  outlook:    { appName: 'Outlook',    iconName: 'outlook_icon',    category: 'productivity', webFallback: 'https://outlook.com/' },
  drive:      { appName: 'Drive',      iconName: 'drive_icon',      category: 'productivity', webFallback: 'https://drive.google.com/' },
  dropbox:    { appName: 'Dropbox',    iconName: 'dropbox_icon',    category: 'productivity', webFallback: 'https://www.dropbox.com/' },
  onepassword:{ appName: '1Password',  iconName: 'onepassword_icon',category: 'productivity', webFallback: 'https://my.1password.com/' },

  venmo:      { appName: 'Venmo',      iconName: 'venmo_icon',      category: 'finance',      webFallback: 'https://venmo.com/' },
  paypal:     { appName: 'PayPal',     iconName: 'paypal_icon',     category: 'finance',      webFallback: 'https://www.paypal.com/' },
  cashapp:    { appName: 'Cash App',   iconName: 'cashapp_icon',    category: 'finance',      webFallback: 'https://cash.app/' },
  robinhood:  { appName: 'Robinhood',  iconName: 'robinhood_icon',  category: 'finance',      webFallback: 'https://robinhood.com/' },
  coinbase:   { appName: 'Coinbase',   iconName: 'coinbase_icon',   category: 'finance',      webFallback: 'https://www.coinbase.com/' },

  amazon:     { appName: 'Amazon',     iconName: 'amazon_icon',     category: 'shopping',     webFallback: 'https://www.amazon.com/' },
  ubereats:   { appName: 'Uber Eats',  iconName: 'ubereats_icon',   category: 'shopping',     webFallback: 'https://www.ubereats.com/' },
  doordash:   { appName: 'DoorDash',   iconName: 'doordash_icon',   category: 'shopping',     webFallback: 'https://www.doordash.com/' },
  target:     { appName: 'Target',     iconName: 'target_icon',     category: 'shopping',     webFallback: 'https://www.target.com/' },
  walmart:    { appName: 'Walmart',    iconName: 'walmart_icon',    category: 'shopping',     webFallback: 'https://www.walmart.com/' },
  instacart:  { appName: 'Instacart',  iconName: 'instacart_icon',  category: 'shopping',     webFallback: 'https://www.instacart.com/' },

  uber:       { appName: 'Uber',       iconName: 'uber_icon',       category: 'travel',       urlScheme: 'uber://',       webFallback: 'https://www.uber.com/' },
  lyft:       { appName: 'Lyft',       iconName: 'lyft_icon',       category: 'travel',       webFallback: 'https://www.lyft.com/' },
  airbnb:     { appName: 'Airbnb',     iconName: 'airbnb_icon',     category: 'travel',       webFallback: 'https://www.airbnb.com/' },
  waze:       { appName: 'Waze',       iconName: 'waze_icon',       category: 'travel',       urlScheme: 'waze://',       webFallback: 'https://www.waze.com/' },
  google_maps:{ appName: 'Google Maps',iconName: 'maps_icon',       category: 'travel',       urlScheme: 'comgooglemaps://', webFallback: 'https://maps.google.com/' },

  disneyplus: { appName: 'Disney+',    iconName: 'disneyplus_icon', category: 'entertainment',webFallback: 'https://www.disneyplus.com/' },
  hulu:       { appName: 'Hulu',       iconName: 'hulu_icon',       category: 'entertainment',webFallback: 'https://www.hulu.com/' },
  twitch:     { appName: 'Twitch',     iconName: 'twitch_icon',     category: 'entertainment',webFallback: 'https://www.twitch.tv/' },
  apple_music:{ appName: 'Apple Music',iconName: 'spotify_icon',    category: 'entertainment',webFallback: 'https://music.apple.com/' },
  soundcloud: { appName: 'SoundCloud', iconName: 'soundcloud_icon', category: 'entertainment',webFallback: 'https://soundcloud.com/' },

  myfitnesspal:{ appName: 'MyFitnessPal', iconName: 'health_icon',  category: 'wellness',     webFallback: 'https://www.myfitnesspal.com/' },
  fitbit:     { appName: 'Fitbit',     iconName: 'fitbit_icon',     category: 'wellness',     webFallback: 'https://www.fitbit.com/' },
  calm:       { appName: 'Calm',       iconName: 'calm_icon',       category: 'wellness',     webFallback: 'https://www.calm.com/' },
  headspace:  { appName: 'Headspace',  iconName: 'headspace_icon',  category: 'wellness',     webFallback: 'https://www.headspace.com/' },

  pocket:     { appName: 'Pocket',     iconName: 'notes_icon',      category: 'skill',        webFallback: 'https://getpocket.com/' },
  medium:     { appName: 'Medium',     iconName: 'medium_icon',     category: 'skill',        webFallback: 'https://medium.com/' },
};

// Keys shown in the browsable "open library" (GET /essential-apps?library=1) and in the
// Preferred Apps / Pin-an-App pickers -- excludes 'scan_food' (an in-app action, not a
// real external app to browse/prefer/pin) so those UIs never show a dead-looking tile.
const LIBRARY_KEYS = Object.keys(CATALOG).filter(k => k !== 'scan_food');

const APPS_BY_PILLAR = {
  Work:      ['mail', 'calendar', 'notes', 'slack', 'zoom', 'whatsapp'],
  Fitness:   ['spotify', 'scan_food', 'health', 'strava', 'podcasts', 'youtube'],
  Diet:      ['scan_food', 'notes', 'spotify', 'health', 'calculator'],
  Finances:  ['notes', 'calculator', 'mail', 'calendar'],
  Relations: ['mail', 'calendar', 'whatsapp', 'notes', 'zoom'],
  Personal:  ['notes', 'spotify', 'duolingo', 'kindle', 'audible', 'brilliant', 'ground_news', 'podcasts'],
};
const DEFAULT_KEYS = ['mail', 'calendar', 'notes', 'spotify', 'calculator', 'whatsapp'];
// The "nothing scheduled right now" fallback (no AI key configured) -- a real mix of
// entertainment + skill-building instead of the task-context utility defaults above,
// since idle time isn't well served by "here's your Mail app again."
const IDLE_KEYS = ['duolingo', 'youtube', 'spotify', 'kindle', 'netflix', 'podcasts', 'brilliant', 'ground_news', 'audible'];

// tool_hint-level overrides layered on top of the pillar list, for the cases where the
// specific task matters more than the pillar overall (a meal-logging task always wants
// Scan Food first regardless of pillar; a workout wants music+health, not the Diet set).
const APPS_BY_TOOL_HINT = {
  meal:    ['scan_food', 'notes', 'spotify'],
  workout: ['spotify', 'health', 'strava', 'podcasts'],
  weight:  ['health', 'notes'],
  transaction: ['calculator', 'notes', 'mail'],
};

// A plain manual task ("Drive to the beach") has no pillar and no tool_hint at all --
// it used to fall straight to DEFAULT_KEYS (Mail/Calendar/Notes/Spotify/Calculator/
// WhatsApp) regardless of what the task actually is, which is exactly why a driving
// errand surfaced a calculator. Same deterministic keyword-match precedent as
// inferToolHint()/isRecurringAction() -- no AI call, just matching what the task text
// itself already says it is.
const ACTIVITY_KEYWORD_RULES = [
  [/\bdriv(e|ing|e to)\b|\bcommut(e|ing)\b|\broad ?trip\b/i, ['maps', 'spotify', 'podcasts', 'phone']],
  [/\bwalk(ing)?\b/i, ['spotify', 'podcasts', 'health']],
  [/\bcook(ing)?\b|\bmeal prep\b/i, ['spotify', 'podcasts', 'scan_food']],
  [/\bclean(ing)?\b|\btidy(ing)?\b|\blaundry\b/i, ['spotify', 'podcasts']],
  [/\bshop(ping)?\b|\bgroceries\b|\berrands?\b/i, ['maps', 'notes', 'calculator']],
];
function inferActivityKeys(name) {
  const text = String(name || '');
  for (const [re, keys] of ACTIVITY_KEYWORD_RULES) if (re.test(text)) return keys;
  return null;
}

function resolveApps(keys) {
  return keys.map(k => CATALOG[k]).filter(Boolean);
}

// "Add your own app" fallback (4.20) -- neither iOS nor Android lets a third-party app
// enumerate everything actually installed on the device, so the curated CATALOG above can
// never be complete. Instead of pretending otherwise, a user can add their own entry (name
// + a URL or URL-scheme they provide) via Settings > Preferred Apps, stored per-user in
// preferences (scope 'custom_apps', {apps:[{id,appName,urlScheme,webFallback,addedAt}]}) --
// reusing the existing generic preferences table/endpoint rather than a new one, since this
// is small, per-user, arbitrary-shaped data that fits it exactly. Merged in here so a custom
// app shows up identically to a curated one everywhere Essential Apps renders (context
// suggestions, break/task drawers, and the open-library search).
async function getCustomApps(sql, userId) {
  const rows = await sql`SELECT data FROM preferences WHERE user_id = ${userId} AND scope = 'custom_apps'`;
  const apps = rows[0]?.data?.apps;
  if (!Array.isArray(apps)) return [];
  return apps.filter(a => a && typeof a.appName === 'string' && a.appName.trim() && (a.urlScheme || a.webFallback));
}
function customAppToEntry(a) {
  return {
    key: 'custom_' + a.id,
    appName: a.appName.trim().slice(0, 60),
    iconName: 'custom_icon',
    category: 'custom',
    urlScheme: a.urlScheme || undefined,
    webFallback: a.webFallback || undefined,
    isCustom: true,
  };
}

const ALL_CATALOG_KEYS = Object.keys(CATALOG);
// A curated context list is often short (2-6 real fits) -- pad it out with the rest of
// the catalog so the drawer never feels thin, capped so it never becomes an unscannable
// wall either. "Show as many as possible, average around 6" per the founder's ask.
function padKeys(keys, min = 6, max = 12) {
  const deduped = [...new Set(keys)];
  const result = deduped.slice(0, max);
  if (result.length < min) {
    for (const k of ALL_CATALOG_KEYS) {
      if (result.length >= min) break;
      if (!result.includes(k)) result.push(k);
    }
  }
  return result.slice(0, max);
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
// Task Detail's "pin an app for this task type" -- e.g. always Spotify for a workout,
// always Notes for a journal task. Looked up by tool_hint, not by pillar, since the
// pairing is about the KIND of action, the same way APPS_BY_TOOL_HINT already overrides
// the pillar-level defaults for that reason.
async function getPinnedKey(sql, userId, toolHint) {
  if (!toolHint) return null;
  const rows = await sql`SELECT data FROM preferences WHERE user_id = ${userId} AND scope = 'app_pairings'`;
  const key = rows[0]?.data?.[toolHint];
  return CATALOG[key] ? key : null;
}
function prioritize(keys, preferredKeys) {
  if (!preferredKeys.length) return keys;
  const preferredSet = new Set(preferredKeys);
  return [...keys.filter(k => preferredSet.has(k)), ...keys.filter(k => !preferredSet.has(k))];
}

const APPS_BY_BREAK = {
  bathroom:     ['duolingo', 'podcasts', 'brilliant', 'ground_news', 'kindle'],
  snack:        ['spotify', 'podcasts', 'scan_food', 'ground_news', 'youtube'],
  stretch:      ['spotify', 'health', 'strava'],
  walk:         ['spotify', 'podcasts', 'health', 'strava'],
  mental_reset: ['notes', 'spotify', 'duolingo', 'ground_news'],
  free_time:    ['duolingo', 'mail', 'notes', 'ground_news', 'youtube', 'netflix', 'kindle'],
};
const HABIT_STACK_HINT = {
  bathroom:     'A quick Duolingo lesson pairs well with a bathroom break.',
  snack:        'Queue up a podcast while you eat.',
  walk:         'Good time for a podcast or a call.',
  free_time:    'One Duolingo lesson beats another scroll.',
};

const SUGGEST_SYSTEM = `You suggest tools from a fixed catalog for someone opening a general "quick tools" drawer in a life-coaching app, with no specific task selected. Pick tools genuinely useful for their current moment (time of day, what's next on their schedule) -- not random, and don't force in a bad fit just to hit a number. If nothing is currently scheduled (genuine free/idle time), favor a real mix of entertainment and skill-building tools over plain utilities like Mail or Calendar, so downtime feels enriching rather than filler. If the person has told you which apps they actually use/prefer, weight picks toward those first. Return ONLY JSON: {"picks": [{"key": "<catalog key>", "reason": "<max 10 words, why this one right now>"}]}. Pick between 6 and 10 tools (never fewer than 6, never more than 10), all keys must come from the provided catalog list, never invent a key.`;

async function aiSuggest(catalogKeys, hour, nextTaskDesc, preferredKeys) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
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

  const customApps = await getCustomApps(sql, user.id).catch(() => []);
  const customEntries = customApps.map(customAppToEntry);

  if (req.query.library) {
    // The full browsable catalog behind the "open library" search bar (4.19), and also
    // the shared source for Settings > Preferred Apps and Task Detail's Pin-an-App picker
    // -- one list instead of three hand-maintained copies, so a new catalog app added
    // above automatically shows up everywhere instead of silently drifting out of sync.
    // Sorted by category then name so it reads like a real launcher's app drawer. A user's
    // own custom apps (4.20) are appended after sorting the curated set so they always
    // land together at the end under a 'custom' category, easy to spot as "mine."
    const entries = LIBRARY_KEYS
      .map(k => ({ key: k, ...CATALOG[k] }))
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.appName.localeCompare(b.appName))
      .concat(customEntries);
    return res.status(200).json({ apps: entries });
  }

  const taskId = req.query.taskId ? Number(req.query.taskId) : null;
  const breakType = req.query.breakType || null;
  const preferredKeys = await getPreferredKeys(sql, user.id);

  if (breakType) {
    const keys = padKeys(prioritize(APPS_BY_BREAK[breakType] || DEFAULT_KEYS, preferredKeys));
    // Custom apps (4.20) always show alongside the curated set -- appended after padKeys'
    // cap rather than competing for one of its slots, since a user added these on purpose.
    return res.status(200).json({ apps: resolveApps(keys).concat(customEntries), habitStack: HABIT_STACK_HINT[breakType] || null });
  }

  if (taskId) {
    const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId} AND user_id = ${user.id}`;
    const task = rows[0];
    const pillarName = task ? PILLARS[task.pillar_id] : null;
    const pinnedKey = await getPinnedKey(sql, user.id, task?.tool_hint);
    const baseKeys = (task?.tool_hint && APPS_BY_TOOL_HINT[task.tool_hint]) || inferActivityKeys(task?.name) || APPS_BY_PILLAR[pillarName] || DEFAULT_KEYS;
    // A pin means "always this app, no exceptions" -- prioritize() only reorders by
    // matching baseKeys' own relative order, so a pin could still lose to an unrelated
    // preferredKey that simply appears earlier in the base list (confirmed live: pinning
    // Health for steps tasks still put Spotify first because Spotify was already in
    // preferredKeys and came first in baseKeys). Pin is forced to the front, unconditionally.
    let keys = padKeys(prioritize(baseKeys, preferredKeys));
    if (pinnedKey) keys = [pinnedKey, ...keys.filter(k => k !== pinnedKey)];
    return res.status(200).json({ apps: resolveApps(keys).concat(customEntries), habitStack: null, pinnedKey });
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
  if (suggested && suggested.length) return res.status(200).json({ apps: suggested.concat(customEntries), habitStack: null, aiSuggested: true });

  return res.status(200).json({ apps: resolveApps(padKeys(prioritize(IDLE_KEYS, preferredKeys))).concat(customEntries), habitStack: null });
}

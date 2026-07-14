// Deterministic scheduling helpers shared by api/goals.js and
// api/side-quests/[id]/activate.js -- no AI call needed for any of this, matching this
// codebase's existing cost-discipline precedent (see essential-apps.js, breaks.js).

// Maps a questionnaire "time of day" answer (either the 4-option Morning/Midday/Evening/
// Flexible set, or Fitness's richer 6-window set) to a clock start time. Substring
// matching handles both vocabularies without needing to branch by pillar.
export function timeOfDayToClock(answer) {
  if (!answer) return '09:00';
  const a = String(answer).toLowerCase();
  if (a.includes('early morning')) return '06:30';
  if (a.includes('mid-morning')) return '09:30';
  if (a.includes('morning')) return '08:00';
  if (a.includes('early afternoon')) return '12:30';
  if (a.includes('late afternoon')) return '15:30';
  if (a.includes('afternoon') || a.includes('midday')) return '14:00';
  if (a.includes('evening')) return '19:00';
  return '09:00'; // Flexible or missing
}

export function addMinutesToClock(clock, minutes) {
  const [h, m] = clock.split(':').map(Number);
  const total = ((h * 60 + m + minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Keyword-matched, not AI-tagged -- lets a generated task deep-link into the real tool
// that fulfills it (Journal, Log a Session, etc.) instead of a bare completion checkbox,
// without an extra AI call or changing the AI's JSON contract (which stays mirrored with
// map-of-you's GOAL_PLAN_SYSTEM).
const TOOL_HINT_RULES = {
  personal: [[/journal|reflect|write down|gratitude/i, 'journal'], [/practice|study|read|meditat|session/i, 'session']],
  diet: [[/meal|eat|cook|snack|recipe|grocery/i, 'meal']],
  fitness: [[/workout|exercise|train|lift|run|walk|stretch/i, 'workout']],
  finances: [[/expense|spend|budget|transaction|track.*(spending|money)/i, 'transaction']],
  relations: [[/call|text|reach out|connect|message|meet up/i, 'connection']],
  work: [[/deep work|focus session|work on|project/i, 'work_session']],
};
export function inferToolHint(pillarKey, text) {
  const rules = TOOL_HINT_RULES[pillarKey] || [];
  for (const [re, hint] of rules) if (re.test(text)) return hint;
  return null;
}

// Keyword-matched, not AI-tagged -- an action whose own text says "every day"/"daily"/
// etc. should materialize as a real recurring routine (reappearing every day regardless
// of whether yesterday's was completed) instead of a one-off, single-day sub-task that
// never repeats even though the plan's own narrative describes it as recurring.
const RECURRING_ACTION_PATTERN = /\bevery ?day\b|\bdaily\b|\beach day\b|\bevery morning\b|\bevery evening\b|\bevery night\b/i;
export function isRecurringAction(text) {
  return RECURRING_ACTION_PATTERN.test(String(text || ''));
}

// Extracts a rough day count from an AI-generated timeline string ("60 days", "6 weeks",
// "21 days", "3 months") so a goal can carry a real end_date instead of only a free-text
// description. Returns null if the phrasing doesn't match (goal stays open-ended).
export function parseTimelineDays(text) {
  const s = String(text || '').toLowerCase();
  const m = s.match(/(\d+)\s*(day|week|month)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'week') return n * 7;
  if (m[2] === 'month') return n * 30;
  return n;
}

// Bin-packs a flat list of sub-task texts into sequential days starting at startDate,
// each day capped at dailyBudgetMinutes, assigning real due_date/start_time/end_time
// within that day's block -- the "2-hour block of the 6-hour project, from a certain
// time to another" scheduling. Returns [{ text, phaseLabel, dueDate, startTime, endTime }].
export function scheduleSubTasks(actions, { startDate, clockStart, dailyBudgetMinutes, subtaskMinutes }) {
  let dayOffset = 0;
  let minutesUsedToday = 0;
  return actions.map(action => {
    if (minutesUsedToday + subtaskMinutes > dailyBudgetMinutes && minutesUsedToday > 0) {
      dayOffset++;
      minutesUsedToday = 0;
    }
    const dueDate = addDays(startDate, dayOffset);
    const startTime = addMinutesToClock(clockStart, minutesUsedToday);
    const endTime = addMinutesToClock(clockStart, minutesUsedToday + subtaskMinutes);
    minutesUsedToday += subtaskMinutes;
    return { ...action, dueDate, startTime, endTime };
  });
}

import { sql, PILLARS } from './db.js';

// Real 4-phase progression model (redesign, 2026-09). Phase is purely a function of
// unlockedCount for 1-3, plus a durable "have you ever hit mastery" flag for 4 -- see
// getPhaseInfo() below for why Phase 4 needs its own persisted flag instead of being
// computed live like the others.
export const PHASE_NAMES = {
  1: 'Phase 1: Foundation',    // 1-3 pillars, freely chosen (see getPillarState canActivateNextPillar)
  2: 'Phase 2: Expansion',     // unlocking pillar 4, 5 or 6, one at a time, consistency-gated
  3: 'Phase 3: Optimization',  // all 6 pillars active -- framing shifts to protecting/optimizing time
  4: 'Phase 4: Flow State',    // mastery -- see getPhaseInfo
};

// Shared phase-gating calc -- used by api/user.js (dashboard/profile) and
// api/user-projects.js (pillar_states for Home/Daily Overview) so both agree on
// exactly the same "is the next pillar unlockable yet" answer.
export async function getPillarState(user) {
  // active = true excludes a pillar the user soft-deactivated via the Phase 1 swap
  // feature (api/pillar/[pillar].js?action=swap) -- its user_pillars row (and all its
  // historical tasks/logs) stays in the table so it can be reactivated with history
  // intact later, it just doesn't count as "currently active" until then.
  const unlockedRows = await sql`SELECT pillar_id, activated_at FROM user_pillars WHERE user_id = ${user.id} AND active = true ORDER BY activated_at ASC`;
  const activePillarIds = unlockedRows.map(r => r.pillar_id);
  const unlockedPillars = activePillarIds.map(id => (PILLARS[id] || '').toLowerCase());
  const unlockedCount = activePillarIds.length;
  const activatedAtByPillar = {};
  unlockedRows.forEach(r => { activatedAtByPillar[(PILLARS[r.pillar_id] || '').toLowerCase()] = r.activated_at; });

  // Phase 1 counts "good morning and night routine AND pillar completion" together --
  // the Morning/Wind-Down bookend routines created at profile-creation time are
  // universal (pillar_id NULL, routine_id set) rather than tied to one active pillar, so
  // they'd otherwise never contribute to this percentage at all.
  let standardPct = 0, fastPct = 0, anyPillarFastHit = false, bestPillarFastPct = 0;
  if (unlockedCount > 0) {
    // kind != 'project' -- a Project's own parent row is a coarse proxy for "how far
    // into the total multi-hour/multi-day scope," not "did today's task happen," and its
    // sub-tasks already contribute their own individual Completed rows to this same
    // pool. Counting the parent row too meant real, substantial progress on a big
    // project (e.g. 10% into a 10-hour project) got double-counted once as several small
    // sub-task wins AND once as a coarse partial-percent "loss" against this average,
    // unfairly dragging phase progress down for someone actually making real headway.
    // Only tasks that have actually COME DUE count toward completion -- a Completed task
    // always counts (a real win), and a Pending/Skipped task counts only once its due date
    // has arrived. A task scheduled for next week isn't a "miss" yet, and a deferred task
    // (due_date nulled by reschedule/skip) is backlog, not a failure -- counting either in
    // the denominator made the percentage read absurdly low right after a plan generates a
    // batch of future tasks, tanking phase progress for no real reason.
    const dueFilter = sql`AND (status = 'Completed' OR (due_date IS NOT NULL AND due_date <= CURRENT_DATE))`;
    const [{ standard_pct }] = await sql`
      SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS standard_pct
      FROM tasks WHERE user_id = ${user.id} AND kind != 'project'
        AND (pillar_id = ANY(${activePillarIds}) OR (routine_id IS NOT NULL AND pillar_id IS NULL))
        AND created_at > now() - interval '21 days' ${dueFilter}
    `;
    const [{ fast_pct }] = await sql`
      SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS fast_pct
      FROM tasks WHERE user_id = ${user.id} AND kind != 'project'
        AND (pillar_id = ANY(${activePillarIds}) OR (routine_id IS NOT NULL AND pillar_id IS NULL))
        AND created_at > now() - interval '7 days' ${dueFilter}
    `;
    standardPct = Number(standard_pct);
    fastPct = Number(fast_pct);

    // Redesign item #3: the fast-track unlock check is no longer "95% averaged across
    // ALL active pillars" (that's what fastPct above still is, and it stays the basis for
    // the profile progress bar / phase_progress display) -- it's "does ANY SINGLE
    // currently-active pillar individually hit 95%", grouped by pillar_id instead of
    // aggregated across all of them, using the identical task-selection/due-date rules as
    // fastPct. Universal bookend routines (pillar_id IS NULL) are excluded here on
    // purpose -- they aren't "one pillar" and shouldn't let a routine alone satisfy this.
    const perPillarRows = await sql`
      SELECT pillar_id, COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS pct
      FROM tasks WHERE user_id = ${user.id} AND kind != 'project'
        AND pillar_id = ANY(${activePillarIds})
        AND created_at > now() - interval '7 days' ${dueFilter}
      GROUP BY pillar_id
    `;
    anyPillarFastHit = perPillarRows.some(r => Number(r.pct) >= 95);
    bestPillarFastPct = perPillarRows.reduce((max, r) => Math.max(max, Number(r.pct)), 0);
  }

  const daysSincePhaseStart = user.phase_start_date
    ? Math.floor((Date.now() - new Date(user.phase_start_date).getTime()) / 86400000)
    : 9999;

  // Redesign item #2: Phase 1 is up to 3 freely-chosen pillars, no consistency gate at
  // all -- unlockedCount 0, 1 or 2 means the pillar about to be activated is #1, #2 or #3,
  // all unconditionally allowed (matches how pillar #1 alone worked before this redesign).
  // The consistency gate only starts applying once unlockedCount >= 3, i.e. unlocking
  // pillar #4 and beyond (entering Phase 2 / Expansion).
  const canActivateNextPillar = unlockedCount < 3
    ? true
    : unlockedCount >= 6
    ? false
    : (daysSincePhaseStart >= 7 && anyPillarFastHit) || (daysSincePhaseStart >= 21 && standardPct >= 80);

  return { activePillarIds, unlockedPillars, unlockedCount, standardPct, fastPct, anyPillarFastHit, bestPillarFastPct, canActivateNextPillar, activatedAtByPillar };
}

// Redesign item #4: real phase tracking instead of just an implicit unlock counter.
// Phases 1-3 are a pure function of unlockedCount (monotonic in normal use -- the Phase 1
// swap feature trades one active pillar for another but never changes the count, see
// api/pillar/[pillar].js?action=swap), so they need no extra persistence.
//
// Phase 4 ("Flow State"/mastery) is different: the founder didn't give an exact entry
// criterion, just asked for something reasonable, documented, and easy to adjust later.
// Chosen here: 70%+ task completion sustained over the trailing 365 days while all 6
// pillars are active -- a "have you actually been living this way for a year" bar, one
// order of magnitude longer than the existing 21-day standard-track window so it reads as
// real mastery rather than a good few weeks. Once met, users.hall_of_fame_eligible is set
// permanently (never unset) so a later dip below 70% doesn't bounce someone back out of
// Phase 4 -- reaching mastery once is the real, durable milestone; day-to-day fluctuation
// after that isn't a demotion. That column also directly marks Hall-of-Fame-eligible users
// in the data model per the redesign spec, even though the Hall of Fame feature itself is
// out of scope for now.
// To change the Phase 4 bar later, this is the only place it's computed.
export async function getPhaseInfo(user, pillarState) {
  const { unlockedCount } = pillarState;
  let hallOfFameEligible = !!user.hall_of_fame_eligible;
  // masteryPercent is computed (and returned) any time all 6 pillars are active, not just
  // once it crosses 70% -- lets the frontend show real "progress toward Flow State" in
  // Phase 3 instead of a dead end, same idea as the standard/fast-track bars for Phase 1/2.
  let masteryPercent = null;
  if (unlockedCount >= 6) {
    const [{ year_pct }] = await sql`
      SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS year_pct
      FROM tasks WHERE user_id = ${user.id} AND created_at > now() - interval '365 days'
    `;
    masteryPercent = Number(year_pct);
    if (!hallOfFameEligible && masteryPercent >= 70) {
      hallOfFameEligible = true;
      await sql`UPDATE users SET hall_of_fame_eligible = true WHERE id = ${user.id} AND hall_of_fame_eligible = false`;
    }
  }
  const phaseNumber = unlockedCount >= 6 ? (hallOfFameEligible ? 4 : 3) : unlockedCount >= 3 ? 2 : 1;
  // users.phase already existed as a column (default 1) but was never actually written
  // anywhere -- admin.js's user list and the AI coach's system prompt (api/ai/chat.js)
  // both read it, but always saw the default. Keeping it in sync here means both get the
  // real phase without needing to recompute it themselves.
  if (Number(user.phase) !== phaseNumber) {
    await sql`UPDATE users SET phase = ${phaseNumber} WHERE id = ${user.id}`;
  }
  return { phaseNumber, phaseName: PHASE_NAMES[phaseNumber] || PHASE_NAMES[1], hallOfFameEligible, masteryPercent };
}

// Shared "glowing/active/inactive" pillar-nav coloring -- used by both
// api/user-projects.js (Home/Daily Overview) and api/user.js (Profile page) so the
// two stay visually consistent, per the Profile page spec's explicit developer note.
export function buildPillarStates({ unlockedPillars, canActivateNextPillar }, recommendedPillar) {
  const recommended = (recommendedPillar || '').toLowerCase();
  return Object.entries(PILLARS).map(([id, name]) => {
    const key = name.toLowerCase();
    const status = unlockedPillars.includes(key) ? 'active'
      : (key === recommended && canActivateNextPillar) ? 'glowing'
      : 'inactive';
    return { pillarName: name, status };
  });
}

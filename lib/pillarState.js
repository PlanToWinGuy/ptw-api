import { sql, PILLARS } from './db.js';

// Shared phase-gating calc -- used by api/user.js (dashboard/profile) and
// api/user-projects.js (pillar_states for Home/Daily Overview) so both agree on
// exactly the same "is the next pillar unlockable yet" answer.
export async function getPillarState(user) {
  const unlockedRows = await sql`SELECT pillar_id, activated_at FROM user_pillars WHERE user_id = ${user.id} ORDER BY activated_at ASC`;
  const activePillarIds = unlockedRows.map(r => r.pillar_id);
  const unlockedPillars = activePillarIds.map(id => (PILLARS[id] || '').toLowerCase());
  const unlockedCount = activePillarIds.length;
  const activatedAtByPillar = {};
  unlockedRows.forEach(r => { activatedAtByPillar[(PILLARS[r.pillar_id] || '').toLowerCase()] = r.activated_at; });

  // Phase 1 counts "good morning and night routine AND pillar completion" together --
  // the Morning/Wind-Down bookend routines created at profile-creation time are
  // universal (pillar_id NULL, routine_id set) rather than tied to one active pillar, so
  // they'd otherwise never contribute to this percentage at all.
  let standardPct = 0, fastPct = 0;
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
  }

  const daysSincePhaseStart = user.phase_start_date
    ? Math.floor((Date.now() - new Date(user.phase_start_date).getTime()) / 86400000)
    : 9999;

  const canActivateNextPillar = unlockedCount === 0
    ? true
    : unlockedCount >= 6
    ? false
    : (daysSincePhaseStart >= 7 && fastPct >= 95) || (daysSincePhaseStart >= 21 && standardPct >= 80);

  return { activePillarIds, unlockedPillars, unlockedCount, standardPct, fastPct, canActivateNextPillar, activatedAtByPillar };
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

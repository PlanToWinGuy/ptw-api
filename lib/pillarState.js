import { sql, PILLARS } from './db.js';

// Shared phase-gating calc -- used by api/user.js (dashboard/profile) and
// api/user-projects.js (pillar_states for Home/Daily Overview) so both agree on
// exactly the same "is the next pillar unlockable yet" answer.
export async function getPillarState(user) {
  const unlockedRows = await sql`SELECT pillar_id FROM user_pillars WHERE user_id = ${user.id} ORDER BY activated_at ASC`;
  const activePillarIds = unlockedRows.map(r => r.pillar_id);
  const unlockedPillars = activePillarIds.map(id => (PILLARS[id] || '').toLowerCase());
  const unlockedCount = activePillarIds.length;

  let standardPct = 0, fastPct = 0;
  if (unlockedCount > 0) {
    const [{ standard_pct }] = await sql`
      SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS standard_pct
      FROM tasks WHERE user_id = ${user.id} AND pillar_id = ANY(${activePillarIds}) AND created_at > now() - interval '21 days'
    `;
    const [{ fast_pct }] = await sql`
      SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS fast_pct
      FROM tasks WHERE user_id = ${user.id} AND pillar_id = ANY(${activePillarIds}) AND created_at > now() - interval '7 days'
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

  return { activePillarIds, unlockedPillars, unlockedCount, standardPct, fastPct, canActivateNextPillar };
}

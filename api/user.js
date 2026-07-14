import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { calculateLifeScore, PILLAR_CAPS } from '../lib/lifescore.js';
import { getPillarState, buildPillarStates } from '../lib/pillarState.js';

const PHASE_NAMES = { 1: 'Phase 1: Come Up', 2: 'Phase 2: Traction', 3: 'Phase 3: Confidence', 4: 'Phase 4: Flow State' };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillarState = await getPillarState(user);
  const { unlockedPillars, unlockedCount, standardPct, fastPct, canActivateNextPillar, activatedAtByPillar } = pillarState;

  // Phase is derived from how many pillars are active, not manually incremented.
  // Phase 4 (Flow State) additionally needs ~70%+ completion across all 6 pillars
  // sustained for about a year -- checked here but will realistically stay dormant
  // until the app has real long-term usage data.
  let phase = unlockedCount >= 6 ? 3 : unlockedCount >= 2 ? 2 : 1;
  if (phase === 3) {
    const [{ year_pct }] = await sql`
      SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Completed') / NULLIF(COUNT(*), 0)), 0) AS year_pct
      FROM tasks WHERE user_id = ${user.id} AND created_at > now() - interval '365 days'
    `;
    if (Number(year_pct) >= 70) phase = 4;
  }

  // LifeScore: real per-pillar XP (task xp_gained + the flat 25/log rate api/metrics.js
  // actually awards) on top of the onboarding baseline set at profile-creation time.
  const taskXpRows = await sql`SELECT pillar_id, COALESCE(SUM(xp_gained), 0) AS xp FROM tasks WHERE user_id = ${user.id} GROUP BY pillar_id`;
  const logXpRows = await sql`SELECT pillar_id, COUNT(*) AS cnt FROM metric_logs WHERE user_id = ${user.id} AND log_type !~ '_template$' GROUP BY pillar_id`;
  const pillarXpByKey = {};
  taskXpRows.forEach(r => { const k = (PILLARS[r.pillar_id] || '').toLowerCase(); if (k) pillarXpByKey[k] = (pillarXpByKey[k] || 0) + Number(r.xp); });
  logXpRows.forEach(r => { const k = (PILLARS[r.pillar_id] || '').toLowerCase(); if (k) pillarXpByKey[k] = (pillarXpByKey[k] || 0) + Number(r.cnt) * 25; });
  const { lifeScore, breakdown } = calculateLifeScore(user.life_score, pillarXpByKey);
  const pillar_states = buildPillarStates(pillarState, user.recommended_pillar);

  const daysInPhase = user.phase_start_date
    ? Math.floor((Date.now() - new Date(user.phase_start_date).getTime()) / 86400000)
    : 0;

  res.status(200).json({
    data: {
      username: user.username || user.name,
      profilePicUrl: null,
      phase: PHASE_NAMES[phase] || PHASE_NAMES[1],
      phaseStartDate: user.phase_start_date,
      days_in_phase: daysInPhase,
      phase_progress: {
        standard_path: { description: 'Achieve 80% completion over 3 weeks', target_percent: 80, current_average_percent: standardPct },
        fast_track_path: { description: 'Achieve 95% completion in 1 week', target_percent: 95, current_week_percent: fastPct },
      },
      unlocked_pillars: unlockedPillars,
      pillar_activated_at: activatedAtByPillar,
      pillar_states,
      can_activate_next_pillar: canActivateNextPillar,
      lifeScore,
      lifescore_baseline: Number(user.life_score),
      lifescore_breakdown: breakdown,
      pillar_caps: PILLAR_CAPS,
      xp: user.xp,
      recommended_pillar: user.recommended_pillar,
      subscription_tier: null,
      valueprint_data: user.valueprint_data || null,
    },
  });
}

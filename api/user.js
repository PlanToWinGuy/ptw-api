import { sql, PILLARS } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { calculateLifeScore, PILLAR_CAPS } from '../lib/lifescore.js';
import { getPillarState, buildPillarStates } from '../lib/pillarState.js';

const PHASE_NAMES = { 1: 'Phase 1: Come Up', 2: 'Phase 2: Traction', 3: 'Phase 3: Confidence', 4: 'Phase 4: Flow State' };
const ALL_PILLAR_KEYS = ['fitness', 'diet', 'finances', 'relations', 'personal', 'work'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const avatarRows = await sql`SELECT data FROM preferences WHERE user_id = ${user.id} AND scope = 'avatar'`;
  const profilePicUrl = avatarRows[0]?.data?.url || null;

  const pillarState = await getPillarState(user);
  const { unlockedPillars, unlockedCount, standardPct, fastPct, canActivateNextPillar, activatedAtByPillar } = pillarState;

  // Pillar priority: an explicit user-set order (Settings) wins outright; otherwise a
  // Valueprint-derived default; otherwise the fixed catalog order. Only unlocked pillars
  // actually get reordered in the response below -- a locked pillar has no nav
  // presence yet regardless of where it ranks.
  const priorityRows = await sql`SELECT data FROM preferences WHERE user_id = ${user.id} AND scope = 'pillar_priority'`;
  const explicitOrder = Array.isArray(priorityRows[0]?.data?.order)
    ? priorityRows[0].data.order.filter(k => ALL_PILLAR_KEYS.includes(k))
    : null;
  // Default order is the fixed catalog order (fitness, diet, finances, relations, personal,
  // work) -- the user's stated preference. An explicit Settings > Pillar Priority order
  // still wins when set; unlocked pillars then appear in that order (effectively activation
  // order too, since only activated pillars are in the list).
  const pillarPriorityOrder = (explicitOrder && explicitOrder.length === ALL_PILLAR_KEYS.length ? explicitOrder : null)
    || ALL_PILLAR_KEYS;
  const sortedUnlockedPillars = [...unlockedPillars].sort((a, b) => pillarPriorityOrder.indexOf(a) - pillarPriorityOrder.indexOf(b));

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

  // LifeScore: real per-pillar XP on top of the onboarding baseline set at profile-creation
  // time. Task-completion XP (tasks.xp_gained) and ad-hoc log XP (metric_logs.xp_gained,
  // now a real per-type amount from lib/lifescore.js's Base Task XP table, not a flat
  // rate) are summed separately -- task-linked logs are excluded from the second query
  // since completeTask() already wrote the same XP onto both the task row and its
  // metric_log row, and double-summing both would count one real action twice.
  const taskXpRows = await sql`SELECT pillar_id, COALESCE(SUM(xp_gained), 0) AS xp FROM tasks WHERE user_id = ${user.id} GROUP BY pillar_id`;
  const logXpRows = await sql`SELECT pillar_id, COALESCE(SUM(xp_gained), 0) AS xp FROM metric_logs WHERE user_id = ${user.id} AND task_id IS NULL AND log_type !~ '_template$' GROUP BY pillar_id`;
  const pillarXpByKey = {};
  taskXpRows.forEach(r => { const k = (PILLARS[r.pillar_id] || '').toLowerCase(); if (k) pillarXpByKey[k] = (pillarXpByKey[k] || 0) + Number(r.xp); });
  logXpRows.forEach(r => { const k = (PILLARS[r.pillar_id] || '').toLowerCase(); if (k) pillarXpByKey[k] = (pillarXpByKey[k] || 0) + Number(r.xp); });
  const { lifeScore, breakdown } = calculateLifeScore(user.life_score, pillarXpByKey);
  const pillar_states = buildPillarStates(pillarState, user.recommended_pillar);

  const daysInPhase = user.phase_start_date
    ? Math.floor((Date.now() - new Date(user.phase_start_date).getTime()) / 86400000)
    : 0;

  res.status(200).json({
    data: {
      username: user.username || user.name,
      profilePicUrl,
      // Edit Profile's autofill was silently broken for every field below -- it read
      // u.dob/u.height/u.weight/etc from this exact response, but none of them were ever
      // actually included, so the form always rendered blank regardless of what PUT
      // /user/profile had really saved.
      dob: user.dob,
      gender: user.gender,
      height: user.height,
      weight: user.weight,
      fitness_level: user.fitness_level,
      diet: user.diet,
      sleep_quality: user.sleep_quality,
      stress_level: user.stress_level,
      wake_time: user.wake_time,
      wind_down_time: user.wind_down_time,
      phase: PHASE_NAMES[phase] || PHASE_NAMES[1],
      phaseStartDate: user.phase_start_date,
      days_in_phase: daysInPhase,
      phase_progress: {
        standard_path: { description: 'Achieve 80% completion over 3 weeks', target_percent: 80, current_average_percent: standardPct },
        fast_track_path: { description: 'Achieve 95% completion in 1 week', target_percent: 95, current_week_percent: fastPct },
      },
      unlocked_pillars: sortedUnlockedPillars,
      pillar_priority_order: pillarPriorityOrder,
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

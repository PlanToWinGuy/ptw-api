import { sql, pillarIdFromName } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { computeConsecutiveDayRuns } from '../lib/streaks.js';
import { evaluateBadges } from '../lib/badges.js';

// One primary log_type per pillar -- the same "what counts as activity in this pillar"
// signal used for both badge counts/streaks and the Streaks endpoint.
const PRIMARY_LOG_TYPE = { fitness: 'workout', diet: 'meal', finances: 'transaction', relations: 'connection', personal: 'personal_log', work: 'work_session' };

function dateStr(d) { return (d instanceof Date ? d.toISOString() : String(d)).split('T')[0]; }

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const pillarKey = String(req.query.pillar || '').toLowerCase();
  const pillar_id = pillarIdFromName(pillarKey);
  const logType = PRIMARY_LOG_TYPE[pillarKey];
  if (!pillar_id || !logType) return res.status(404).json({ message: 'Unknown pillar' });

  const logs = await sql`SELECT * FROM metric_logs WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND log_type = ${logType} ORDER BY logged_at ASC`;
  const logDatesAsc = logs.map(l => dateStr(l.logged_at));
  const { longestEver } = computeConsecutiveDayRuns(logDatesAsc);

  const completedGoalRows = await sql`
    SELECT t.updated_at FROM tasks t JOIN goals g ON g.id = t.goal_id
    WHERE t.user_id = ${user.id} AND t.kind = 'project' AND t.status = 'Completed' AND g.pillar_id = ${pillar_id}
    ORDER BY t.updated_at ASC
  `;
  const completedGoalDatesAsc = completedGoalRows.map(r => dateStr(r.updated_at));

  const completedQuestRows = await sql`
    SELECT completed_at FROM side_quests WHERE user_id = ${user.id} AND pillar_id = ${pillar_id} AND is_completed = true AND completed_at IS NOT NULL ORDER BY completed_at ASC
  `;
  const completedQuestDatesAsc = completedQuestRows.map(r => dateStr(r.completed_at));

  const ctx = {
    logCount: logs.length,
    logDatesAsc,
    longestStreakLen: longestEver?.length || 0,
    longestStreakDate: longestEver?.endDate || null,
    completedGoalsCount: completedGoalDatesAsc.length,
    completedGoalDatesAsc,
    completedQuestsCount: completedQuestDatesAsc.length,
    completedQuestDatesAsc,
  };

  if (pillarKey === 'fitness') {
    const prDatesAsc = [];
    for (const l of logs) if ((l.data?.prs || []).length) prDatesAsc.push(dateStr(l.logged_at));
    ctx.prCount = prDatesAsc.length;
    ctx.prDatesAsc = prDatesAsc;

    let cumVolume = 0, volumeCrossDate = null;
    const typesSeen = new Set();
    let thirdActivityTypeDate = null;
    for (const l of logs) {
      const type = l.data?.activityType || 'strength';
      if (type === 'strength') {
        cumVolume += Number(l.value) || 0;
        if (!volumeCrossDate && cumVolume >= 5000) volumeCrossDate = dateStr(l.logged_at);
      }
      typesSeen.add(type);
      if (typesSeen.size >= 3 && !thirdActivityTypeDate) thirdActivityTypeDate = dateStr(l.logged_at);
    }
    ctx.totalVolume = cumVolume;
    ctx.volumeCrossDate = volumeCrossDate;
    ctx.activityTypesUsed = typesSeen.size;
    ctx.thirdActivityTypeDate = thirdActivityTypeDate;

    const cardio5k = logs.filter(l => l.data?.activityType === 'cardio' && Number(l.data?.distance) >= 5);
    ctx.max5kDistance = cardio5k.length ? Math.max(...cardio5k.map(l => Number(l.data.distance))) : 0;
    ctx.first5kDate = cardio5k.length ? dateStr(cardio5k[0].logged_at) : null;
  }

  const badges = evaluateBadges(pillarKey, ctx);
  const earned = badges.filter(b => b.is_earned);
  const latest = earned.reduce((best, b) => (!best || (b.date_earned && b.date_earned > best.date_earned)) ? b : best, null);
  // "Rarest" = the highest-rarity badge among this user's OWN earned badges (rarity is an
  // explicit designer-authored tier, see lib/badges.js) -- not a fabricated population stat.
  const rarest = earned.reduce((best, b) => (!best || b.rarity > best.rarity) ? b : best, null);

  res.status(200).json({
    quick_stats: {
      rarest_badge_earned: rarest?.name || null,
      badges_collected: earned.length,
      total_badges_available: badges.length,
      latest_badge_earned: latest?.name || null,
    },
    badges,
  });
}

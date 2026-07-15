import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { calculateBaseline, calculateLifeScore } from '../../lib/lifescore.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'PUT') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const body = req.body || {};
  const fullName = body.fullName;
  const username = body.username;
  const dateOfBirth = body.dateOfBirth;
  const gender = body.gender;
  const height = body.height?.value;
  const weight = body.weight?.value;
  const fitnessLevel = body.fitnessLevel;
  const typicalDiet = body.typicalDiet;
  const sleepQuality = body.sleepQuality;
  const stressLevel = body.stressLevel;
  const wakeTime = body.wakeTime;
  const windDownTime = body.windDownTime;

  if (username && username !== user.username) {
    const existing = await sql`SELECT id FROM users WHERE username = ${username} AND id != ${user.id}`;
    if (existing.length) return res.status(422).json({ message: 'Validation failed', errors: { username: ['That username is already taken.'] } });
  }

  // Only recalculate the LifeScore baseline when a health-related field actually
  // changed -- an unrelated edit (e.g. just the display name) shouldn't reset it. Was
  // previously ignoring sleepQuality/stressLevel entirely (never checked for a change,
  // and always recalculated off the stale DB value even when it did), so editing either
  // one here silently had zero effect on LifeScore.
  const healthFieldsChanged = (height != null && Number(height) !== Number(user.height))
    || (weight != null && Number(weight) !== Number(user.weight))
    || (fitnessLevel != null && fitnessLevel !== user.fitness_level)
    || (sleepQuality != null && sleepQuality !== user.sleep_quality)
    || (stressLevel != null && stressLevel !== user.stress_level);
  const newBaseline = healthFieldsChanged
    ? calculateBaseline({
        dob: dateOfBirth ?? user.dob,
        height: height ?? user.height,
        weight: weight ?? user.weight,
        fitness_level: fitnessLevel ?? user.fitness_level,
        sleep_quality: sleepQuality ?? user.sleep_quality,
        stress_level: stressLevel ?? user.stress_level,
      }).baseline
    : Number(user.life_score);

  const rows = await sql`
    UPDATE users SET
      name = COALESCE(${fullName}, name),
      username = COALESCE(${username}, username),
      dob = COALESCE(${dateOfBirth || null}, dob),
      gender = COALESCE(${gender || null}, gender),
      height = COALESCE(${height ?? null}, height),
      weight = COALESCE(${weight ?? null}, weight),
      fitness_level = COALESCE(${fitnessLevel}, fitness_level),
      diet = COALESCE(${typicalDiet}, diet),
      sleep_quality = COALESCE(${sleepQuality}, sleep_quality),
      stress_level = COALESCE(${stressLevel}, stress_level),
      wake_time = COALESCE(${wakeTime || null}, wake_time),
      wind_down_time = COALESCE(${windDownTime || null}, wind_down_time),
      life_score = ${newBaseline}
    WHERE id = ${user.id}
    RETURNING *
  `;
  const updated = rows[0];

  const taskXpRows = await sql`SELECT pillar_id, COALESCE(SUM(xp_gained), 0) AS xp FROM tasks WHERE user_id = ${user.id} GROUP BY pillar_id`;
  const logXpRows = await sql`SELECT pillar_id, COALESCE(SUM(xp_gained), 0) AS xp FROM metric_logs WHERE user_id = ${user.id} AND task_id IS NULL AND log_type !~ '_template$' GROUP BY pillar_id`;
  const pillarXpByKey = {};
  taskXpRows.forEach(r => { const k = (PILLARS[r.pillar_id] || '').toLowerCase(); if (k) pillarXpByKey[k] = (pillarXpByKey[k] || 0) + Number(r.xp); });
  logXpRows.forEach(r => { const k = (PILLARS[r.pillar_id] || '').toLowerCase(); if (k) pillarXpByKey[k] = (pillarXpByKey[k] || 0) + Number(r.xp); });
  const { lifeScore } = calculateLifeScore(updated.life_score, pillarXpByKey);

  res.status(200).json({
    message: 'Profile updated successfully.',
    user: { id: updated.id, name: updated.name, username: updated.username, lifeScore },
  });
}

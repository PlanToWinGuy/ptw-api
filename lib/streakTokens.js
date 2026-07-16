import { PILLARS } from './db.js';

// Per MSD 2.6.3 "Dynamic Save Streak System": a day's completion rate for a pillar
// auto-preserves the streak at 50%+; below that a "Streak Save" token is spent (if the
// bank has one) so the streak doesn't break. A token is earned per pillar after a full
// 7-day window at 90%+ completion. Bank caps at 2 tokens per pillar.
const AUTO_SAVE_THRESHOLD = 0.5;
const AWARD_THRESHOLD = 0.9;
const MAX_TOKENS_PER_PILLAR = 2;
const MAX_CATCHUP_DAYS = 60; // safety cap so a very stale account can't loop forever

function dateStr(d) { return (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0]; }

async function pillarCompletionRate(sql, userId, pillarId, dateFrom, dateTo) {
  const rows = await sql`
    SELECT status FROM tasks
    WHERE user_id = ${userId} AND pillar_id = ${pillarId} AND kind IN ('simple', 'habit')
      AND due_date BETWEEN ${dateFrom} AND ${dateTo}
  `;
  if (!rows.length) return null; // nothing scheduled -- not evaluable, doesn't help or hurt
  const completed = rows.filter(r => r.status === 'Completed').length;
  return completed / rows.length;
}

// Lazy reconciliation, same pattern as materializeRoutinesForDate: called on every
// request that touches Daily Overview, walks the user's cursor forward day-by-day up
// through yesterday (today isn't finished yet), spending/earning tokens as it goes.
// Idempotent per day via streak_saves' UNIQUE(user_id, pillar_id, save_date).
export async function reconcileStreakTokens(sql, user) {
  const yesterday = new Date(); yesterday.setHours(0, 0, 0, 0); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateStr(yesterday);

  const startCursor = user.streak_tokens_checked_through ? new Date(dateStr(user.streak_tokens_checked_through) + 'T00:00:00') : new Date(user.created_at);
  startCursor.setHours(0, 0, 0, 0);
  if (dateStr(startCursor) >= yesterdayStr) return; // already caught up

  const accountCreated = new Date(user.created_at); accountCreated.setHours(0, 0, 0, 0);
  const tokens = { ...(user.streak_save_tokens || {}) };
  const pillarEntries = Object.entries(PILLARS); // [id, name]

  const cursor = new Date(startCursor);
  let iterations = 0;
  while (dateStr(cursor) < yesterdayStr && iterations < MAX_CATCHUP_DAYS) {
    iterations++;
    const cursorStr = dateStr(cursor);

    for (const [pillarIdStr, pillarName] of pillarEntries) {
      const pillarId = Number(pillarIdStr);
      const key = pillarName.toLowerCase();
      const rate = await pillarCompletionRate(sql, user.id, pillarId, cursorStr, cursorStr);
      if (rate === null) continue;
      if (rate < AUTO_SAVE_THRESHOLD) {
        const have = tokens[key] || 0;
        if (have > 0) {
          const inserted = await sql`
            INSERT INTO streak_saves (user_id, pillar_id, save_date) VALUES (${user.id}, ${pillarId}, ${cursorStr})
            ON CONFLICT (user_id, pillar_id, save_date) DO NOTHING RETURNING id
          `;
          if (inserted.length) tokens[key] = have - 1;
        }
      }
    }

    // Weekly award check: every 7th day since account creation, evaluate the trailing
    // 7-day window (inclusive) that just closed.
    const daysSinceCreated = Math.round((cursor - accountCreated) / 86400000);
    if (daysSinceCreated > 0 && daysSinceCreated % 7 === 0) {
      const weekStartStr = dateStr(new Date(cursor.getTime() - 6 * 86400000));
      for (const [pillarIdStr, pillarName] of pillarEntries) {
        const pillarId = Number(pillarIdStr);
        const key = pillarName.toLowerCase();
        const rate = await pillarCompletionRate(sql, user.id, pillarId, weekStartStr, cursorStr);
        if (rate !== null && rate >= AWARD_THRESHOLD) {
          tokens[key] = Math.min(MAX_TOKENS_PER_PILLAR, (tokens[key] || 0) + 1);
        }
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  await sql`
    UPDATE users SET streak_save_tokens = ${JSON.stringify(tokens)}::jsonb, streak_tokens_checked_through = ${dateStr(cursor)}
    WHERE id = ${user.id}
  `;
}

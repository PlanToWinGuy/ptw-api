import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import { exchangeAuthCodeForTokens, revokeRefreshToken, syncDayForUser, deleteEventForTask } from '../lib/googleCalendar.js';

// Google Calendar sync -- consolidated into one function (?action=), same pattern as
// api/auth.js and api/tasks/update-completion.js, to stay under the Hobby plan's
// function-count limit. This is a SEPARATE grant from Google Sign-In (api/auth.js's
// 'google' action): connecting Calendar here never happens as a side effect of login.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const action = req.query.action;

  if (req.method === 'GET' && !action) {
    return res.status(200).json({
      connected: !!user.google_calendar_refresh_token,
      syncEnabled: !!user.google_calendar_sync_enabled,
      connectedAt: user.google_calendar_connected_at,
      timezone: user.timezone,
    });
  }

  if (req.method === 'POST' && action === 'connect') {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ message: 'Google Calendar sync is not configured on the server yet.' });
    }
    const { code, timezone } = req.body || {};
    if (!code) return res.status(422).json({ message: 'code is required' });

    const result = await exchangeAuthCodeForTokens(code);
    if (result.error) {
      const messages = {
        not_configured: 'Google Calendar sync is not configured on the server yet.',
        no_refresh_token: "Google didn't grant lasting access -- try disconnecting Plan To Win from your Google Account's Third-party access page, then connect again.",
        exchange_failed: 'Could not complete Google Calendar sign-in -- try again.',
      };
      return res.status(400).json({ message: messages[result.error] || 'Could not connect Google Calendar.' });
    }

    // A valid IANA zone (e.g. 'America/New_York'), captured client-side from
    // Intl.DateTimeFormat().resolvedOptions().timeZone -- best-effort loose validation
    // (real validation would need the full tz database); a garbage value here would only
    // ever make this one user's own events show at the wrong time, never break anything
    // else, so this is just enough to reject an obviously malformed value.
    const tz = typeof timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(timezone) ? timezone : null;

    await sql`
      UPDATE users SET
        google_calendar_refresh_token = ${result.refreshToken},
        google_calendar_sync_enabled = true,
        google_calendar_connected_at = now(),
        timezone = COALESCE(${tz}, timezone)
      WHERE id = ${user.id}
    `;
    return res.status(200).json({ message: 'Google Calendar connected.', connected: true, syncEnabled: true });
  }

  if (req.method === 'POST' && action === 'disconnect') {
    // Clean up every event we've pushed BEFORE revoking -- once the token's revoked we
    // can no longer call the API on this user's behalf, so this ordering is the only way
    // to avoid leaving orphaned events sitting on their real calendar forever.
    const taskRows = await sql`
      SELECT * FROM tasks WHERE user_id = ${user.id} AND google_calendar_event_id IS NOT NULL
    `;
    for (const task of taskRows) {
      await deleteEventForTask(sql, user, task).catch(() => {});
    }
    if (user.google_calendar_refresh_token) await revokeRefreshToken(user.google_calendar_refresh_token);
    await sql`
      UPDATE users SET google_calendar_refresh_token = NULL, google_calendar_sync_enabled = false, google_calendar_connected_at = NULL
      WHERE id = ${user.id}
    `;
    return res.status(200).json({ message: 'Google Calendar disconnected.', connected: false });
  }

  if (req.method === 'PUT' && action === 'toggle') {
    const { enabled } = req.body || {};
    if (!user.google_calendar_refresh_token) return res.status(422).json({ message: 'Connect Google Calendar first.' });
    await sql`UPDATE users SET google_calendar_sync_enabled = ${!!enabled} WHERE id = ${user.id}`;
    if (!enabled) {
      // Turning sync off means "not on my calendar" -- clean up what's already there
      // rather than leaving stale events behind that PTW will no longer keep in sync.
      const taskRows = await sql`SELECT * FROM tasks WHERE user_id = ${user.id} AND google_calendar_event_id IS NOT NULL`;
      const stillEnabledUser = { ...user, google_calendar_sync_enabled: true }; // deleteEventForTask just needs a live refresh_token, not the flag
      for (const task of taskRows) {
        await deleteEventForTask(sql, stillEnabledUser, task).catch(() => {});
      }
    } else {
      // Turning it back on: push the next week's schedule immediately rather than
      // waiting for the next task mutation or app-load sync to notice.
      const today = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(today.getTime() + i * 86400000).toISOString().split('T')[0];
        await syncDayForUser(sql, { ...user, google_calendar_sync_enabled: true }, d).catch(() => {});
      }
    }
    return res.status(200).json({ message: enabled ? 'Google Calendar sync turned on.' : 'Google Calendar sync turned off.', syncEnabled: !!enabled });
  }

  if (req.method === 'POST' && action === 'sync-day') {
    const { date } = req.body || {};
    const targetDate = date || new Date().toISOString().split('T')[0];
    const result = await syncDayForUser(sql, user, targetDate);
    return res.status(200).json({ message: 'Sync complete.', ...result });
  }

  res.status(404).json({ message: 'Unknown calendar action' });
}

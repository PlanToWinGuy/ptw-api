// Google Calendar sync -- one-directional PTW -> Google Calendar push (see schema.sql's
// Google Calendar comment for the storage design). This is a SEPARATE grant from Google
// Sign-In (api/auth.js's 'google' action, google_id): incremental authorization, requested
// only when someone opts into sync from Settings, not bundled into login.
//
// Scope: 'calendar.events' (create/update/delete events on calendars the user already has
// access to) rather than the full 'calendar' scope (which also grants managing calendar
// *settings and calendar list*, none of which this feature needs) or a '.readonly' variant
// (which can't write at all, and this is a push -- PTW never needs to read the user's
// existing calendar back). This is the least-privileged scope that satisfies "create/
// update/delete events on the user's primary calendar."
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const EVENTS_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function creds() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// Exchanges the one-time authorization code the frontend's incremental-auth popup
// (google.accounts.oauth2.initCodeClient, ux_mode:'popup') hands back for a refresh_token.
// redirect_uri MUST be the literal string 'postmessage' for a popup-mode code client --
// that's not a placeholder, it's what Google's own docs specify for this exact flow (no
// real redirect ever happens; the code comes back via postMessage instead).
export async function exchangeAuthCodeForTokens(code) {
  const c = creds();
  if (!c) return { error: 'not_configured' };
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: data.error || 'exchange_failed', description: data.error_description };
  // A refresh_token only comes back the FIRST time a user consents (or after they've
  // revoked and re-consent) -- Google's documented behavior, not a bug on our end. If
  // someone disconnects-then-reconnects without Google prompting a fresh consent screen,
  // this can come back empty; the frontend surfaces that as "try disconnecting from your
  // Google Account's own permissions page first" rather than silently storing nothing.
  if (!data.refresh_token) return { error: 'no_refresh_token' };
  return { refreshToken: data.refresh_token, accessToken: data.access_token, expiresIn: data.expires_in };
}

async function refreshAccessToken(refreshToken) {
  const c = creds();
  if (!c) return { error: 'not_configured' };
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json().catch(() => ({}));
  // invalid_grant is what Google returns for a refresh_token that's been revoked (by the
  // user, from myaccount.google.com/permissions) or expired -- the one case the caller
  // needs to distinguish, since it means "stop trying, the connection is gone" rather than
  // a transient failure worth retrying.
  if (!r.ok) return { error: data.error || 'refresh_failed', revoked: data.error === 'invalid_grant' };
  return { accessToken: data.access_token };
}

export async function revokeRefreshToken(refreshToken) {
  try {
    await fetch(REVOKE_URL + '?token=' + encodeURIComponent(refreshToken), { method: 'POST' });
  } catch (e) {
    // Best-effort -- we're clearing our own stored copy regardless of whether Google's
    // revoke call itself succeeds, so a network blip here shouldn't block disconnecting.
  }
}

// Not persisted -- re-derived from the stored refresh_token on every sync call. Call
// volume here is low (a handful of task mutations per user per day), so the extra HTTP
// round-trip is cheap and this avoids ever storing a second, shorter-lived secret.
async function getAccessTokenForUser(user) {
  if (!user.google_calendar_refresh_token) return { error: 'not_connected' };
  return refreshAccessToken(user.google_calendar_refresh_token);
}

function pad2(n) { return String(n).padStart(2, '0'); }

// A DATE column comes back from the neon driver as a native JS Date; a TIME column comes
// back as a plain "HH:MM:SS" string -- same normalization lib/tasks.js already has to do
// for the same reason.
function dateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
}
function timeStr(t) {
  if (!t) return null;
  return String(t).slice(0, 8);
}

function addMinutes(hhmmss, minutes) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}:${pad2(s || 0)}`;
}

// A task is eligible for a calendar event only once it's a real, still-pending, timed
// commitment: a due_date + start_time (unscheduled/backlog tasks have neither -- nothing
// to put on a calendar), and status still 'Pending' (a Completed/Skipped task shouldn't
// keep occupying a slot on someone's real calendar).
function isEligible(task) {
  return task.status === 'Pending' && !!task.due_date && !!task.start_time;
}

function eventResourceForTask(task, timezone) {
  const due = dateStr(task.due_date);
  const start = timeStr(task.start_time);
  const end = task.end_time ? timeStr(task.end_time) : addMinutes(start, task.estimated_duration_minutes || 30);
  const tz = timezone || 'UTC';
  return {
    summary: task.name,
    description: [task.notes, '\nSynced automatically from Plan To Win.'].filter(Boolean).join('\n'),
    start: { dateTime: `${due}T${start}`, timeZone: tz },
    end: { dateTime: `${due}T${end}`, timeZone: tz },
    // Round-trip marker only (this is a one-way push; PTW never reads events back), kept
    // for anyone debugging directly in the Google Calendar UI/API to see where an event
    // came from and which PTW task it maps to.
    extendedProperties: { private: { ptwTaskId: String(task.id) } },
    source: { title: 'Plan To Win', url: 'https://app.plantowin.app' },
  };
}

async function callEventsApi(method, accessToken, path, body) {
  const r = await fetch(EVENTS_BASE + path, {
    method,
    headers: {
      authorization: 'Bearer ' + accessToken,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return { ok: true, status: 204 };
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data.error };
  return { ok: true, status: r.status, data };
}

// Creates, updates, or removes the ONE Google Calendar event tied to this task (via
// task.google_calendar_event_id), so the caller can call this after any mutation to a
// single task -- completion, skip, manual reschedule, edit -- without needing to know
// which of those three cases applies. Best-effort by design: returns a result object
// rather than throwing, so a Google API hiccup never breaks the underlying task action
// that triggered it (every call site wraps this and only logs a failure).
export async function upsertEventForTask(sql, user, task) {
  if (!user.google_calendar_sync_enabled || !user.google_calendar_refresh_token) return { skipped: 'not_connected' };

  const tokenResult = await getAccessTokenForUser(user);
  if (tokenResult.error) {
    if (tokenResult.revoked) await disableAfterRevocation(sql, user.id);
    return { skipped: tokenResult.error };
  }
  const accessToken = tokenResult.accessToken;

  if (!isEligible(task)) {
    return deleteEventForTask(sql, user, task, accessToken);
  }

  const resource = eventResourceForTask(task, user.timezone);

  if (task.google_calendar_event_id) {
    const result = await callEventsApi('PATCH', accessToken, '/' + encodeURIComponent(task.google_calendar_event_id), resource);
    if (result.ok) return { ok: true, action: 'updated', eventId: task.google_calendar_event_id };
    if (result.status === 404 || result.status === 410) {
      // The event was deleted on Google's side (e.g. directly in Google Calendar) --
      // fall through and create a fresh one rather than failing forever.
      await sql`UPDATE tasks SET google_calendar_event_id = NULL WHERE id = ${task.id}`;
    } else {
      return { ok: false, error: result.error };
    }
  }

  const created = await callEventsApi('POST', accessToken, '', resource);
  if (!created.ok) return { ok: false, error: created.error };
  await sql`UPDATE tasks SET google_calendar_event_id = ${created.data.id} WHERE id = ${task.id}`;
  return { ok: true, action: 'created', eventId: created.data.id };
}

export async function deleteEventForTask(sql, user, task, accessTokenIn) {
  if (!task.google_calendar_event_id) return { skipped: 'no_event' };
  let accessToken = accessTokenIn;
  if (!accessToken) {
    const tokenResult = await getAccessTokenForUser(user);
    if (tokenResult.error) {
      if (tokenResult.revoked) await disableAfterRevocation(sql, user.id);
      return { skipped: tokenResult.error };
    }
    accessToken = tokenResult.accessToken;
  }
  const result = await callEventsApi('DELETE', accessToken, '/' + encodeURIComponent(task.google_calendar_event_id));
  // 404/410/"already gone" is a success from our point of view -- the end state (no event
  // on the calendar) is exactly what we wanted.
  await sql`UPDATE tasks SET google_calendar_event_id = NULL WHERE id = ${task.id}`;
  if (result.ok || result.status === 404 || result.status === 410) return { ok: true, action: 'deleted' };
  return { ok: false, error: result.error };
}

// The day-level reconciliation entry point: makes Google Calendar match PTW's current
// schedule for exactly this one date, for this one user. Self-healing by construction --
// safe (and cheap: one query, up to one API call per task on that day, all best-effort) to
// call after any bulk change (Shuffle Day, routine materialization, goal generation) or
// just periodically on app load, rather than needing every single mutation call site
// wired individually.
export async function syncDayForUser(sql, user, dateStr) {
  if (!user.google_calendar_sync_enabled || !user.google_calendar_refresh_token) return { skipped: 'not_connected' };

  // Project sub-tasks are included deliberately -- they carry their own real due_date/
  // start_time/end_time for a specific day (see api/tasks/update-completion.js's
  // confirm-shuffle handling of parent_task_id) and are just as legitimate a timed
  // calendar commitment as a standalone task; only the parent Project row itself (which
  // has no start_time of its own) is naturally excluded by isEligible() below.
  const tasks = await sql`
    SELECT * FROM tasks
    WHERE user_id = ${user.id} AND due_date = ${dateStr}
  `;

  const tokenResult = await getAccessTokenForUser(user);
  if (tokenResult.error) {
    if (tokenResult.revoked) await disableAfterRevocation(sql, user.id);
    return { skipped: tokenResult.error };
  }
  const accessToken = tokenResult.accessToken;

  let created = 0, updated = 0, deleted = 0, failed = 0;
  for (const task of tasks) {
    if (isEligible(task)) {
      const resource = eventResourceForTask(task, user.timezone);
      if (task.google_calendar_event_id) {
        const r = await callEventsApi('PATCH', accessToken, '/' + encodeURIComponent(task.google_calendar_event_id), resource);
        if (r.ok) { updated++; continue; }
        if (r.status !== 404 && r.status !== 410) { failed++; continue; }
        await sql`UPDATE tasks SET google_calendar_event_id = NULL WHERE id = ${task.id}`;
      }
      const r2 = await callEventsApi('POST', accessToken, '', resource);
      if (r2.ok) { await sql`UPDATE tasks SET google_calendar_event_id = ${r2.data.id} WHERE id = ${task.id}`; created++; }
      else failed++;
    } else if (task.google_calendar_event_id) {
      const r = await deleteEventForTask(sql, user, task, accessToken);
      if (r.ok) deleted++; else failed++;
    }
  }
  return { ok: true, created, updated, deleted, failed, totalTasks: tasks.length };
}

// Wrapper for every task-mutation call site below: sync must never be able to break the
// underlying task action that triggered it (a completed checkbox, a reschedule, a delete
// all need to succeed regardless of Google's API being reachable), so this swallows any
// exception upsertEventForTask/syncDayForUser doesn't already turn into a result object.
export async function safeUpsertEventForTask(sql, user, task) {
  try {
    return await upsertEventForTask(sql, user, task);
  } catch (e) {
    console.error('googleCalendar.upsertEventForTask failed:', String(e));
    return { ok: false, error: String(e) };
  }
}

export async function safeSyncDayForUser(sql, user, dateStr) {
  try {
    return await syncDayForUser(sql, user, dateStr);
  } catch (e) {
    console.error('googleCalendar.syncDayForUser failed:', String(e));
    return { ok: false, error: String(e) };
  }
}

// A revoked/expired refresh_token means Google will reject every future call the same
// way -- rather than silently failing on every task mutation forever, turn sync off and
// drop the dead token so Settings shows "not connected" (and a real "Connect" flow, not a
// broken "toggle" that looks on but never works) the next time the user looks.
async function disableAfterRevocation(sql, userId) {
  await sql`UPDATE users SET google_calendar_sync_enabled = false, google_calendar_refresh_token = NULL WHERE id = ${userId}`;
}

// In-app notification history only (4.18.A) -- a plain insert at the moment a real
// event happens, no queue/job/push delivery. deepLinkTarget is {page, params} or null.
export async function createNotification(sql, userId, { iconType, message, deepLinkTarget = null }) {
  await sql`
    INSERT INTO notifications (user_id, icon_type, message, deep_link_target)
    VALUES (${userId}, ${iconType}, ${message}, ${deepLinkTarget ? JSON.stringify(deepLinkTarget) : null})
  `;
}

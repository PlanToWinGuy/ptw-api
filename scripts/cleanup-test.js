import { neon } from '@neondatabase/serverless';
import { del } from '@vercel/blob';
const sql = neon(process.env.DATABASE_URL);
const emails = ['projecttest-verify@plantowin.app', 'visiontest-verify@plantowin.app', 'logotest-verify@plantowin.app', 'notifchat-verify@plantowin.app', 'questtest-verify@plantowin.app', 'uifixtest-verify@plantowin.app', 'pass1test-verify@plantowin.app'];

const blobs = await sql`SELECT blob_pathname FROM vision_board_images WHERE user_id IN (SELECT id FROM users WHERE email = ANY(${emails}))`;
for (const b of blobs) await del(b.blob_pathname);

await sql`DELETE FROM users WHERE email = ANY(${emails})`;
console.log('cleaned', blobs.length, 'blobs and matching users');

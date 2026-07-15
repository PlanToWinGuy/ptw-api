import { neon } from '@neondatabase/serverless';
import { del } from '@vercel/blob';
const sql = neon(process.env.DATABASE_URL);
const emails = ['projecttest-verify@plantowin.app', 'visiontest-verify@plantowin.app', 'logotest-verify@plantowin.app', 'notifchat-verify@plantowin.app', 'questtest-verify@plantowin.app', 'uifixtest-verify@plantowin.app', 'pass1test-verify@plantowin.app', 'pass2test-verify@plantowin.app', 'pass3test-verify@plantowin.app', 'pass4test-verify@plantowin.app', 'pass56test-verify@plantowin.app', 'pass7test-verify@plantowin.app', 'pass89test-verify@plantowin.app', 'pass10test-verify@plantowin.app', 'diettargets-verify@plantowin.app', 'pass11test-verify@plantowin.app'];

const blobs = await sql`SELECT blob_pathname FROM vision_board_images WHERE user_id IN (SELECT id FROM users WHERE email = ANY(${emails}))`;
for (const b of blobs) await del(b.blob_pathname);

await sql`DELETE FROM users WHERE email = ANY(${emails})`;
console.log('cleaned', blobs.length, 'blobs and matching users');

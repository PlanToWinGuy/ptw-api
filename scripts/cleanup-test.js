import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
await sql`DELETE FROM users WHERE email IN ('navprofile-test@plantowin.app', 'navprofile-test2@plantowin.app')`;
console.log('cleaned');

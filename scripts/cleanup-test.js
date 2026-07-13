import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
await sql`DELETE FROM users WHERE email IN ('projecttest-verify@plantowin.app')`;
console.log('cleaned');

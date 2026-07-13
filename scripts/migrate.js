import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { neon } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = neon(process.env.DATABASE_URL);
const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');

const statements = schema
  .split(/;\s*(?:\n|$)/)
  .map(s => s.trim())
  .filter(Boolean);

for (const stmt of statements) {
  await sql.query(stmt);
  console.log('OK:', stmt.split('\n')[0].slice(0, 60));
}
console.log('Migration complete.');

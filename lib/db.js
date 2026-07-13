import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL);

export const PILLARS = {
  1: 'Fitness',
  2: 'Diet',
  3: 'Finances',
  4: 'Relations',
  5: 'Personal',
  6: 'Work',
};

export function pillarIdFromName(name) {
  if (!name) return null;
  const entry = Object.entries(PILLARS).find(([, n]) => n.toLowerCase() === String(name).toLowerCase());
  return entry ? Number(entry[0]) : null;
}

// Apply the database schema (safe to run more than once).
// Usage: netlify dev:exec node scripts/migrate.js
import { getSql, SCHEMA } from '../lib/db.js';

const sql = getSql();
for (const stmt of SCHEMA) {
  const result = await sql.query(stmt, [], { fullResults: true });
  const first = stmt.trim().split('\n')[0].slice(0, 70);
  console.log(`${result.command} ${result.rowCount ?? ''}`.trim().padEnd(14), first);
}
console.log('Schema is up to date.');

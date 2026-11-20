// One-time import of the old MongoDB export into Postgres.
// Usage: netlify dev:exec node scripts/import-data.js <path-to-backup.json> [--replace]
import { readFileSync } from 'node:fs';
import { getSql, SCHEMA } from '../lib/db.js';

const CITIES = ['Dar-es-salaam', 'Arusha', 'Handeni', 'Tanga', 'Moshi', 'Others'];

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: netlify dev:exec node scripts/import-data.js <backup.json> [--replace]');
  process.exit(1);
}
const sql = getSql();

const people = JSON.parse(readFileSync(file, 'utf8')).people;
if (!Array.isArray(people)) throw new Error('Backup file has no "people" array');

const bad = people.filter((p) => !CITIES.includes(p.city));
if (bad.length) throw new Error(`${bad.length} records have an unknown city`);

for (const stmt of SCHEMA) {
  await sql.query(stmt);
}

const [{ count }] = await sql`SELECT count(*)::int AS count FROM people`;
if (count > 0 && flag !== '--replace') {
  console.error(`The people table already has ${count} rows. Re-run with --replace to wipe and re-import.`);
  process.exit(1);
}

// Renumber each city 1..n in the old order, so positions are always clean.
const byCity = {};
for (const p of [...people].sort((a, b) => a.order - b.order)) (byCity[p.city] ??= []).push(p);
const rows = Object.values(byCity).flatMap((list) => list.map((p, i) => ({ ...p, position: i + 1 })));

const col = (f) => rows.map(f);
await sql.transaction([
  sql`DELETE FROM people`,
  sql`INSERT INTO people (name, birthdate, contact, blood_group, city, position)
      SELECT * FROM unnest(
        ${col((p) => (p.name ?? '').trim())}::text[],
        ${col((p) => p.birthdate || null)}::date[],
        ${col((p) => (p.contact ?? '').trim())}::text[],
        ${col((p) => (p.bloodGroup ?? '').trim())}::text[],
        ${col((p) => p.city)}::text[],
        ${col((p) => p.position)}::int[])`,
]);

const totals = await sql`SELECT city, count(*)::int AS n FROM people GROUP BY city ORDER BY city`;
console.log(`Imported ${rows.length} of ${people.length} records:`);
for (const t of totals) console.log(`  ${t.city}: ${t.n}`);

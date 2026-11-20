import { getSql, cleanName } from '../../lib/db.js';

// GET  /api/cities          -> [{ name, label, count }] in the order they were added
// POST /api/cities {label}  -> add a city (anyone can)
export const config = { path: '/api/cities' };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req) => {
  try {
    const sql = getSql();

    if (req.method === 'GET') {
      const rows = await sql.query(
        `SELECT c.name, c.label, count(p.id)::int AS count
         FROM cities c LEFT JOIN people p ON p.city = c.name AND p.in_directory
         GROUP BY c.name, c.label, c.created_at
         ORDER BY c.created_at, c.label`);
      return json(200, rows);
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const label = cleanName(body?.label);
      if (label.length < 2 || label.length > 40) return json(400, { error: 'City names are 2 to 40 characters long' });
      if (!/^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(label)) return json(400, { error: 'Use letters, spaces and hyphens only' });

      const [existing] = await sql.query(`SELECT name, label FROM cities WHERE lower(label) = lower($1) OR lower(name) = lower($1)`, [label]);
      if (existing) return json(409, { error: `${existing.label} is already in the list`, city: existing });

      const [row] = await sql.query(`INSERT INTO cities (name, label) VALUES ($1, $1) RETURNING name, label`, [label]);
      return json(201, { ...row, count: 0 });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

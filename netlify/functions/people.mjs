import { getSql, cityExists, toJson, readFields, setClause, snapshotPerson, PERSON_COLUMNS } from '../../lib/db.js';

// GET  /api/people?city=Arusha            -> people listed in a city, in order
// POST /api/people  {city, name, ...}       -> add at the end of the city's list
// POST /api/people  {city, position, ...}   -> insert at that position, shifting the rest down
// PUT  /api/people/:id {name, ...}          -> update only the fields sent
//      {city: 'Mtwara'} moves them to the end of that city's list; {city: null} takes them
//      off the city lists (they stay in the family tree).
export const config = { path: ['/api/people', '/api/people/:id'] };

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export default async (req, context) => {
  try {
    const sql = getSql();
    const idParam = context.params?.id;

    if (idParam === undefined) {
      if (req.method === 'GET') {
        const city = new URL(req.url).searchParams.get('city');
        if (!(await cityExists(sql, city))) return json(400, { error: 'Unknown city' });
        const rows = await sql.query(
          `SELECT ${PERSON_COLUMNS} FROM people WHERE city = $1 AND in_directory ORDER BY position, id`, [city]);
        return json(200, rows.map(toJson));
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!(await cityExists(sql, body?.city))) return json(400, { error: 'Unknown city' });
        const { fields, error } = readFields(body);
        if (error) return json(400, { error });
        if (!fields.name) return json(400, { error: 'Enter a name' });

        const cols = Object.keys(fields);
        const vals = cols.map((c) => fields[c]);
        const n = vals.length;
        let row;
        if (body.position === undefined || body.position === null) {
          [row] = await sql.query(
            `INSERT INTO people (${cols.join(', ')}, city, position)
             SELECT ${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${n + 1}, COALESCE(MAX(position), 0) + 1
             FROM people WHERE city = $${n + 1}
             RETURNING ${PERSON_COLUMNS}`, [...vals, body.city]);
        } else {
          const position = body.position;
          if (!Number.isInteger(position) || position < 1) {
            return json(400, { error: 'Position must be a positive whole number' });
          }
          // Shift and insert in one transaction so the list never ends up with duplicates.
          const results = await sql.transaction([
            sql.query(`UPDATE people SET position = position + 1 WHERE city = $1 AND position >= $2`, [body.city, position]),
            sql.query(`INSERT INTO people (${cols.join(', ')}, city, position)
                       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${n + 1}, $${n + 2})
                       RETURNING ${PERSON_COLUMNS}`, [...vals, body.city, position]),
          ]);
          [row] = results[1];
        }
        return json(201, toJson(row));
      }

      return json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
    }

    const id = Number(idParam);
    if (!Number.isInteger(id) || id < 1) return json(400, { error: 'Invalid id' });

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const { fields, error } = readFields(body);
      if (error) return json(400, { error });
      if ('name' in fields && !fields.name) return json(400, { error: 'Enter a name' });

      const [current] = await sql.query(`SELECT city, in_directory FROM people WHERE id = $1`, [id]);
      if (!current) return json(404, { error: 'Not found' });

      const queries = [];
      if (body && 'city' in body && body.city !== current.city) {
        if (body.city === null) {
          queries.push(sql.query(`UPDATE people SET city = NULL, position = NULL, in_directory = false WHERE id = $1`, [id]));
        } else {
          if (!(await cityExists(sql, body.city))) return json(400, { error: 'Unknown city' });
          queries.push(sql.query(
            `UPDATE people SET city = $1, in_directory = true,
               position = (SELECT COALESCE(MAX(position), 0) + 1 FROM people WHERE city = $1)
             WHERE id = $2`, [body.city, id]));
        }
      }
      const set = setClause(fields);
      queries.push(sql.query(
        `UPDATE people SET ${set.sql ? set.sql + ', ' : ''}updated_at = now()
         WHERE id = $${set.values.length + 1} RETURNING ${PERSON_COLUMNS}`, [...set.values, id]));

      const results = await sql.transaction(queries);
      const [row] = results.at(-1);
      return json(200, toJson(row));
    }

    if (req.method === 'DELETE') {
      // Keep a copy (with links) so it can be restored from Recently deleted.
      const results = await sql.transaction([
        snapshotPerson(sql, id, 'deleted'),
        sql.query(`DELETE FROM people WHERE id = $1 RETURNING id, name`, [id]),
      ]);
      const [row] = results[1];
      if (!row) return json(404, { error: 'Not found' });
      return json(200, row);
    }

    return json(405, { error: 'Method not allowed' }, { Allow: 'PUT, DELETE' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

import { getSql, wouldCreateLoop, readFields, toJson, PERSON_COLUMNS } from '../../lib/db.js';

// GET    /api/family                       -> everyone (directory + ancestors) and all marriages
// PUT    /api/people/:id/parents {fatherId?, motherId?}   (null clears a parent)
// POST   /api/marriages {a, b}
// DELETE /api/marriages?a=1&b=2
// POST   /api/ancestors {name}             -> add someone who is not in the directory
export const config = { path: ['/api/family', '/api/people/:id/parents', '/api/marriages', '/api/ancestors'] };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const readBody = async (req) => { try { return await req.json(); } catch { return null; } };
const asId = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export default async (req, context) => {
  try {
    const sql = getSql();
    const path = new URL(req.url).pathname;

    if (path === '/api/family' && req.method === 'GET') {
      const [people, marriages] = await Promise.all([
        sql.query(`SELECT ${PERSON_COLUMNS} FROM people ORDER BY city NULLS LAST, position, id`),
        sql.query(`SELECT a_id, b_id FROM marriages`),
      ]);
      return json(200, { people: people.map(toJson), marriages: marriages.map((m) => [m.a_id, m.b_id]) });
    }

    if (context.params?.id !== undefined && req.method === 'PUT') {
      const id = Number(context.params.id);
      const body = await readBody(req);
      if (!Number.isInteger(id) || !body) return json(400, { error: 'Invalid request' });
      const [person] = await sql.query(`SELECT id, father_id, mother_id FROM people WHERE id = $1`, [id]);
      if (!person) return json(404, { error: 'Not found' });

      const next = { father_id: person.father_id, mother_id: person.mother_id };
      for (const [field, key] of [['father_id', 'fatherId'], ['mother_id', 'motherId']]) {
        if (!(key in body)) continue;
        if (body[key] === null) { next[field] = null; continue; }
        const parentId = asId(body[key]);
        if (!parentId) return json(400, { error: `${key} must be a person id or null` });
        const [exists] = await sql.query(`SELECT 1 FROM people WHERE id = $1`, [parentId]);
        if (!exists) return json(400, { error: 'That parent no longer exists' });
        if (await wouldCreateLoop(sql, id, parentId)) {
          return json(400, { error: 'That would make someone their own ancestor' });
        }
        next[field] = parentId;
      }
      if (next.father_id && next.father_id === next.mother_id) return json(400, { error: 'Father and mother must be different people' });
      await sql.query(`UPDATE people SET father_id = $1, mother_id = $2, updated_at = now() WHERE id = $3`,
        [next.father_id, next.mother_id, id]);
      return json(200, { id, fatherId: next.father_id, motherId: next.mother_id });
    }

    if (path === '/api/marriages') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const a = asId(body?.a), b = asId(body?.b);
        if (!a || !b || a === b) return json(400, { error: 'Choose two different people' });
        await sql.query(`INSERT INTO marriages (a_id, b_id) VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int))
                         ON CONFLICT DO NOTHING`, [a, b]);
        return json(201, { a, b });
      }
      if (req.method === 'DELETE') {
        const q = new URL(req.url).searchParams;
        const a = Number(q.get('a')), b = Number(q.get('b'));
        await sql.query(`DELETE FROM marriages WHERE a_id = LEAST($1::int, $2::int) AND b_id = GREATEST($1::int, $2::int)`, [a, b]);
        return json(200, { a, b });
      }
    }

    if (path === '/api/ancestors' && req.method === 'POST') {
      // Someone in the family tree who is not on any city list: usually an ancestor or someone who has passed away.
      const { fields, error } = readFields(await readBody(req));
      if (error) return json(400, { error });
      if (!fields.name) return json(400, { error: 'Enter a name' });
      const cols = Object.keys(fields);
      const [row] = await sql.query(
        `INSERT INTO people (${cols.join(', ')}, in_directory, city, position)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, false, NULL, NULL)
         RETURNING ${PERSON_COLUMNS}`, cols.map((c) => fields[c]));
      return json(201, toJson(row));
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

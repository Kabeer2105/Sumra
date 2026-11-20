import { getSql, wouldCreateLoop, snapshotPerson } from '../../lib/db.js';

// POST /api/people/:id/merge {otherId}   -> fold a double entry into this person, then remove it
// GET  /api/deleted                      -> recently deleted or merged people
// POST /api/deleted/:id/restore          -> bring a deleted person back, with their links
export const config = { path: ['/api/people/:id/merge', '/api/deleted', '/api/deleted/:id/restore'] };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (req, context) => {
  try {
    const sql = getSql();
    const path = new URL(req.url).pathname;

    if (path.endsWith('/merge') && req.method === 'POST') {
      const keep = Number(context.params.id);
      const body = await req.json().catch(() => null);
      const other = Number(body?.otherId);
      if (!Number.isInteger(keep) || !Number.isInteger(other) || keep === other) return json(400, { error: 'Choose two different people' });

      const rows = await sql.query(`SELECT id, name FROM people WHERE id = ANY($1::int[])`, [[keep, other]]);
      if (rows.length !== 2) return json(404, { error: 'One of these people no longer exists' });
      if (await wouldCreateLoop(sql, keep, other) || await wouldCreateLoop(sql, other, keep)) {
        return json(400, { error: 'One of them is recorded as the other\'s ancestor. Fix those links on their cards before merging.' });
      }
      const keepName = rows.find((r) => r.id === keep).name;
      const [o] = await sql.query(`SELECT father_id, mother_id FROM people WHERE id = $1`, [other]);
      for (const parent of [o.father_id, o.mother_id]) {
        if (parent && parent !== keep && await wouldCreateLoop(sql, keep, parent)) {
          return json(400, { error: 'The double has a parent who is recorded as a descendant of the person you are keeping. Fix that link first.' });
        }
      }

      await sql.transaction([
        snapshotPerson(sql, other, `merged into ${keepName}`),
        // Fill anything the kept entry is missing from the double.
        sql.query(
          `UPDATE people k SET
             birthdate   = COALESCE(k.birthdate, o.birthdate),
             birth_year  = COALESCE(k.birth_year, o.birth_year),
             deceased    = k.deceased OR o.deceased,
             death_date  = COALESCE(k.death_date, o.death_date),
             death_year  = COALESCE(k.death_year, o.death_year),
             contact     = CASE WHEN k.contact = '' THEN o.contact ELSE k.contact END,
             blood_group = CASE WHEN k.blood_group = '' THEN o.blood_group ELSE k.blood_group END,
             notes       = CASE WHEN k.notes = '' THEN o.notes
                                WHEN o.notes = '' OR o.notes = k.notes THEN k.notes
                                ELSE k.notes || E'\\n' || o.notes END,
             father_id   = COALESCE(k.father_id, NULLIF(o.father_id, k.id)),
             mother_id   = COALESCE(k.mother_id, NULLIF(o.mother_id, k.id)),
             in_directory = k.in_directory OR o.in_directory,
             city        = CASE WHEN k.in_directory THEN k.city ELSE o.city END,
             position    = CASE WHEN k.in_directory THEN k.position ELSE o.position END,
             updated_at  = now()
           FROM people o WHERE k.id = $1 AND o.id = $2`, [keep, other]),
        // Children and marriages of the double now belong to the kept entry.
        sql.query(`UPDATE people SET father_id = $1 WHERE father_id = $2 AND id <> $1`, [keep, other]),
        sql.query(`UPDATE people SET mother_id = $1 WHERE mother_id = $2 AND id <> $1`, [keep, other]),
        sql.query(
          `INSERT INTO marriages (a_id, b_id)
           SELECT LEAST($1::int, s), GREATEST($1::int, s) FROM (
             SELECT CASE WHEN a_id = $2 THEN b_id ELSE a_id END AS s FROM marriages WHERE a_id = $2 OR b_id = $2
           ) x WHERE s <> $1
           ON CONFLICT DO NOTHING`, [keep, other]),
        sql.query(`DELETE FROM people WHERE id = $1`, [other]),
      ]);
      return json(200, { keptId: keep, removedId: other });
    }

    if (path === '/api/deleted' && req.method === 'GET') {
      const rows = await sql.query(
        `SELECT id, person_id, data->>'name' AS name, data->>'city' AS city, (data->>'in_directory')::boolean AS in_directory,
                reason, deleted_at, jsonb_array_length(child_links) AS children, cardinality(spouses) AS spouses
         FROM deleted_people ORDER BY deleted_at DESC LIMIT 200`);
      return json(200, rows.map((r) => ({
        id: r.id, personId: r.person_id, name: r.name, city: r.city, inDirectory: r.in_directory,
        reason: r.reason, deletedAt: r.deleted_at, children: r.children, spouses: r.spouses,
      })));
    }

    if (path.endsWith('/restore') && req.method === 'POST') {
      const id = Number(context.params.id);
      const [d] = await sql.query(`SELECT * FROM deleted_people WHERE id = $1`, [id]);
      if (!d) return json(404, { error: 'Already restored or not found' });
      const [taken] = await sql.query(`SELECT 1 FROM people WHERE id = $1`, [d.person_id]);
      if (taken) return json(409, { error: 'This person is already back in the list' });
      const pid = d.person_id;
      const data = JSON.stringify(d.data);
      const childLinks = JSON.stringify(d.child_links);

      await sql.transaction([
        // Parents are re-linked separately, only if they still exist.
        sql.query(`INSERT INTO people SELECT * FROM jsonb_populate_record(NULL::people, $1::jsonb - 'father_id' - 'mother_id')`, [data]),
        sql.query(`UPDATE people SET father_id = f.id FROM people f WHERE people.id = $1 AND f.id = ($2::jsonb->>'father_id')::int`, [pid, data]),
        sql.query(`UPDATE people SET mother_id = m.id FROM people m WHERE people.id = $1 AND m.id = ($2::jsonb->>'mother_id')::int`, [pid, data]),
        // Children get this parent back only where that parent slot is still empty.
        sql.query(`UPDATE people c SET father_id = $1 FROM jsonb_to_recordset($2::jsonb) AS l(id int, role text)
                   WHERE c.id = l.id AND l.role = 'father' AND c.father_id IS NULL`, [pid, childLinks]),
        sql.query(`UPDATE people c SET mother_id = $1 FROM jsonb_to_recordset($2::jsonb) AS l(id int, role text)
                   WHERE c.id = l.id AND l.role = 'mother' AND c.mother_id IS NULL`, [pid, childLinks]),
        sql.query(`INSERT INTO marriages (a_id, b_id)
                   SELECT LEAST($1::int, s), GREATEST($1::int, s) FROM unnest($2::int[]) s
                   WHERE EXISTS (SELECT 1 FROM people WHERE id = s) AND s <> $1
                   ON CONFLICT DO NOTHING`, [pid, d.spouses]),
        sql.query(`DELETE FROM deleted_people WHERE id = $1`, [id]),
      ]);
      return json(200, { restoredId: pid });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

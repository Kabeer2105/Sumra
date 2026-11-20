import { getSql, wouldCreateLoop } from '../../lib/db.js';
import { cleanName } from '../../lib/names.js';
import { buildSuggestions } from '../../lib/suggest.js';

// GET  /api/suggestions  -> review questions built from names and list order
// POST /api/decide       -> record an answer (and apply it when it is a yes)
export const config = { path: ['/api/suggestions', '/api/decide'] };

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const ids = (v) => (Array.isArray(v) ? v.filter((x) => Number.isInteger(x) && x > 0) : []);

async function loadState(sql) {
  const [people, marriages, decisions] = await Promise.all([
    sql.query(`SELECT id, name, birth_year, city, position, in_directory, father_id, mother_id FROM people`),
    sql.query(`SELECT a_id, b_id FROM marriages`),
    sql.query(`SELECT kind, person_id, candidate, decision FROM link_decisions`),
  ]);
  return {
    people: people.map((r) => ({ id: r.id, name: r.name, birthYear: r.birth_year, city: r.city, position: r.position,
      inDirectory: r.in_directory, fatherId: r.father_id, motherId: r.mother_id })),
    marriages: marriages.map((m) => [m.a_id, m.b_id]),
    decisions: decisions.map((d) => ({ kind: d.kind, personId: d.person_id, candidate: d.candidate, decision: d.decision })),
  };
}

const record = (sql, kind, personId, candidate, decision) => sql.query(
  `INSERT INTO link_decisions (kind, person_id, candidate, decision) VALUES ($1, $2, $3, $4)
   ON CONFLICT (kind, person_id, candidate) DO UPDATE SET decision = EXCLUDED.decision, decided_at = now()`,
  [kind, personId, String(candidate), decision]);

export default async (req) => {
  try {
    const sql = getSql();
    const path = new URL(req.url).pathname;

    if (path === '/api/suggestions' && req.method === 'GET') {
      const state = await loadState(sql);
      const cards = buildSuggestions(state);
      const unsure = state.decisions.filter((d) => d.decision === 'unsure').length;
      const linked = state.people.filter((p) => p.fatherId || p.motherId).length;
      return json(200, { cards, unsure, linked, total: state.people.length, marriages: state.marriages.length });
    }

    if (path !== '/api/decide' || req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await req.json().catch(() => null);
    if (!body?.type) return json(400, { error: 'Missing type' });

    switch (body.type) {
      // { personId, fatherId } | { personId, rejectIds:[...] } | { personId, unsure:true } | { personId, spouseId }
      case 'father': {
        const personId = Number(body.personId);
        if (!Number.isInteger(personId)) return json(400, { error: 'Invalid person' });
        if (Number.isInteger(body.fatherId)) {
          if (await wouldCreateLoop(sql, personId, body.fatherId)) return json(400, { error: 'That would make someone their own ancestor' });
          await sql.transaction([
            sql.query(`UPDATE people SET father_id = $1, updated_at = now() WHERE id = $2`, [body.fatherId, personId]),
            record(sql, 'father', personId, body.fatherId, 'yes'),
          ]);
        } else if (Number.isInteger(body.spouseId)) {
          await sql.transaction([
            sql.query(`INSERT INTO marriages (a_id, b_id) VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int)) ON CONFLICT DO NOTHING`, [personId, body.spouseId]),
            record(sql, 'father', personId, body.spouseId, 'no'),
          ]);
        } else if (body.unsure) {
          await record(sql, 'father', personId, '*', 'unsure');
        } else {
          const rejects = ids(body.rejectIds);
          if (!rejects.length) return json(400, { error: 'Nothing to record' });
          await sql.transaction(rejects.map((c) => record(sql, 'father', personId, c, 'no')));
        }
        break;
      }

      // { a, b, answer: 'yes' | 'no' | 'unsure' }
      case 'spouse': {
        const a = Math.min(body.a, body.b), b = Math.max(body.a, body.b);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return json(400, { error: 'Invalid pair' });
        const answer = ['yes', 'no', 'unsure'].includes(body.answer) ? body.answer : null;
        if (!answer) return json(400, { error: 'Invalid answer' });
        const queries = [record(sql, 'spouse', a, b, answer)];
        if (answer === 'yes') queries.push(sql.query(`INSERT INTO marriages (a_id, b_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a, b]));
        await sql.transaction(queries);
        break;
      }

      // { motherId, acceptIds:[...], rejectIds:[...] } | { motherId, unsureIds:[...] }
      case 'mother': {
        const motherId = Number(body.motherId);
        if (!Number.isInteger(motherId)) return json(400, { error: 'Invalid mother' });
        const accept = ids(body.acceptIds), reject = ids(body.rejectIds), unsure = ids(body.unsureIds);
        for (const childId of accept) {
          if (await wouldCreateLoop(sql, childId, motherId)) return json(400, { error: 'That would make someone their own ancestor' });
        }
        const queries = [
          ...accept.map((c) => sql.query(`UPDATE people SET mother_id = $1, updated_at = now() WHERE id = $2 AND mother_id IS NULL`, [motherId, c])),
          ...accept.map((c) => record(sql, 'mother', c, motherId, 'yes')),
          ...reject.map((c) => record(sql, 'mother', c, motherId, 'no')),
          ...unsure.map((c) => record(sql, 'mother', c, motherId, 'unsure')),
        ];
        if (!queries.length) return json(400, { error: 'Nothing to record' });
        await sql.transaction(queries);
        break;
      }

      // { nameKey, name, acceptIds:[...], rejectIds:[...] } | { nameKey, unsureIds:[...] }
      case 'ancestor': {
        const nameKey = String(body.nameKey || '');
        const accept = ids(body.acceptIds), reject = ids(body.rejectIds), unsure = ids(body.unsureIds);
        const queries = [
          ...reject.map((c) => record(sql, 'ancestor', c, nameKey, 'no')),
          ...unsure.map((c) => record(sql, 'ancestor', c, nameKey, 'unsure')),
          ...accept.map((c) => record(sql, 'ancestor', c, nameKey, 'yes')),
        ];
        if (accept.length) {
          const name = cleanName(body.name).slice(0, 200);
          if (!name) return json(400, { error: 'Missing ancestor name' });
          // Create the ancestor and link the children in one statement.
          queries.unshift(sql.query(
            `WITH a AS (INSERT INTO people (name, in_directory, city, position) VALUES ($1, false, NULL, NULL) RETURNING id)
             UPDATE people SET father_id = (SELECT id FROM a), updated_at = now() WHERE id = ANY($2::int[]) AND father_id IS NULL`,
            [name, accept]));
        }
        if (!queries.length) return json(400, { error: 'Nothing to record' });
        await sql.transaction(queries);
        break;
      }

      case 'reset-unsure':
        await sql.query(`DELETE FROM link_decisions WHERE decision = 'unsure'`);
        break;

      default:
        return json(400, { error: 'Unknown type' });
    }
    return json(200, { ok: true });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

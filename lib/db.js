import { neon } from '@neondatabase/serverless';
import { cleanName } from './names.js';

export { cleanName };

let sql;

// Netlify DB sets NETLIFY_DATABASE_URL; DATABASE_URL works for any other Postgres.
export function getSql() {
  if (!sql) {
    const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('No database URL: set NETLIFY_DATABASE_URL or DATABASE_URL');
    sql = neon(url);
  }
  return sql;
}

export async function cityExists(sql, name) {
  if (typeof name !== 'string' || !name) return false;
  const rows = await sql.query(`SELECT 1 FROM cities WHERE name = $1`, [name]);
  return rows.length > 0;
}

// Every statement is safe to run again. Run with: netlify dev:exec node scripts/migrate.js
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    birthdate   DATE,
    contact     TEXT NOT NULL DEFAULT '',
    blood_group TEXT NOT NULL DEFAULT '',
    city        TEXT NOT NULL,
    position    INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS people_city_position ON people (city, position)`,

  // Family links. Ancestors who are not in the directory have in_directory = false and no city.
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS father_id INTEGER REFERENCES people(id) ON DELETE SET NULL`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS mother_id INTEGER REFERENCES people(id) ON DELETE SET NULL`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS in_directory BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE people ALTER COLUMN city DROP NOT NULL`,
  `ALTER TABLE people ALTER COLUMN position DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS people_father ON people (father_id)`,
  `CREATE INDEX IF NOT EXISTS people_mother ON people (mother_id)`,

  `CREATE TABLE IF NOT EXISTS marriages (
    a_id       INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    b_id       INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (a_id, b_id),
    CHECK (a_id < b_id)
  )`,

  // Answers given on the review screen, so the same question is never asked twice.
  `CREATE TABLE IF NOT EXISTS link_decisions (
    kind       TEXT NOT NULL,
    person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    candidate  TEXT NOT NULL,
    decision   TEXT NOT NULL CHECK (decision IN ('yes', 'no', 'unsure')),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, person_id, candidate)
  )`,

  // Cities are data, so anyone can add one from the site.
  `CREATE TABLE IF NOT EXISTS cities (
    name       TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cities_label_lower ON cities (lower(label))`,
  `INSERT INTO cities (name, label, created_at) VALUES
     ('Dar-es-salaam', 'Dar es Salaam', '2025-05-01'), ('Arusha', 'Arusha', '2025-05-02'),
     ('Handeni', 'Handeni', '2025-05-03'), ('Tanga', 'Tanga', '2025-05-04'),
     ('Moshi', 'Moshi', '2025-05-05'), ('Others', 'Others', '2025-05-06')
   ON CONFLICT (name) DO NOTHING`,

  // Life details. Dates can be exact (birthdate / death_date) or just a year when that is all anyone knows.
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS birth_year INTEGER`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS deceased BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS death_date DATE`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS death_year INTEGER`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`,
  `UPDATE people SET birth_year = extract(year FROM birthdate)::int WHERE birthdate IS NOT NULL AND birth_year IS NULL`,

  // Deleted and merged people are kept here so they can be restored, links included.
  `CREATE TABLE IF NOT EXISTS deleted_people (
    id          SERIAL PRIMARY KEY,
    person_id   INTEGER NOT NULL,
    data        JSONB NOT NULL,
    child_links JSONB NOT NULL DEFAULT '[]',
    spouses     INTEGER[] NOT NULL DEFAULT '{}',
    reason      TEXT NOT NULL DEFAULT '',
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  // Tidy names: invisible characters pasted from phones, and doubled spaces.
  `UPDATE people
   SET name = btrim(regexp_replace(regexp_replace(name, '[\\u200B-\\u200D\\u2060\\uFEFF]', '', 'g'), '\\s+', ' ', 'g'))
   WHERE name ~ '[\\u200B-\\u200D\\u2060\\uFEFF]|\\s\\s|^\\s|\\s$'`,
];

// Columns every endpoint returns for a person.
export const PERSON_COLUMNS = `id, name, to_char(birthdate, 'YYYY-MM-DD') AS birthdate, birth_year, deceased,
  to_char(death_date, 'YYYY-MM-DD') AS death_date, death_year, notes, contact, blood_group,
  city, position, in_directory, father_id, mother_id`;

// Shape a database row for the browser.
export function toJson(row) {
  return {
    id: row.id,
    name: row.name,
    birthdate: row.birthdate ?? '',
    birthYear: row.birth_year ?? null,
    deceased: !!row.deceased,
    deathDate: row.death_date ?? '',
    deathYear: row.death_year ?? null,
    notes: row.notes ?? '',
    contact: row.contact,
    bloodGroup: row.blood_group,
    city: row.city,
    position: row.position,
    inDirectory: row.in_directory,
    fatherId: row.father_id ?? null,
    motherId: row.mother_id ?? null,
  };
}

function parseDate(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return { value: null };
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    return { error: `${label} must be a real date (YYYY-MM-DD)` };
  }
  if (d > new Date()) return { error: `${label} can't be in the future` };
  return { value: s };
}

function parseYear(v, label) {
  if (v === null || v === undefined || v === '') return { value: null };
  const y = Number(v);
  if (!Number.isInteger(y) || y < 1700 || y > new Date().getFullYear()) return { error: `${label} must be a year between 1700 and now` };
  return { value: y };
}

// Validate the editable fields sent by the browser. Only keys present in the body are returned,
// so a form that doesn't show a field never clears it. Returns { fields } (column -> value) or { error }.
export function readFields(body) {
  if (!body || typeof body !== 'object') return { error: 'Request body must be JSON' };
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const f = {};

  if (has('name')) f.name = cleanName(body.name).slice(0, 200);
  if (has('contact')) f.contact = text(body.contact, 100);
  if (has('bloodGroup')) f.blood_group = text(body.bloodGroup, 10);
  if (has('notes')) f.notes = text(body.notes, 2000);

  for (const [dateKey, yearKey, dateCol, yearCol, label] of [
    ['birthdate', 'birthYear', 'birthdate', 'birth_year', 'Birth'],
    ['deathDate', 'deathYear', 'death_date', 'death_year', 'Death'],
  ]) {
    if (has(dateKey)) {
      const r = parseDate(body[dateKey], `${label} date`);
      if (r.error) return r;
      f[dateCol] = r.value;
      if (r.value) f[yearCol] = Number(r.value.slice(0, 4)); // an exact date also fills the year
      else if (!has(yearKey)) f[yearCol] = null; // clearing the date clears the year too
    }
    if (has(yearKey) && !(dateCol in f && f[dateCol])) {
      const r = parseYear(body[yearKey], `${label} year`);
      if (r.error) return r;
      f[yearCol] = r.value;
    }
  }

  if (has('deceased')) f.deceased = !!body.deceased;
  if (f.death_date || f.death_year) f.deceased = true;
  if (f.deceased === false) { f.death_date = null; f.death_year = null; }

  if (f.birth_year && f.death_year && f.death_year < f.birth_year) return { error: 'Death year is before the birth year' };
  return { fields: f };
}

// Build "col = $n" pairs for an UPDATE from readFields output.
export function setClause(fields, startAt = 1) {
  const cols = Object.keys(fields);
  return {
    sql: cols.map((c, i) => `${c} = $${startAt + i}`).join(', '),
    values: cols.map((c) => fields[c]),
  };
}

// Copy a person, their children's links to them and their marriages into deleted_people.
// Returns a query to run in the same transaction as the delete.
export function snapshotPerson(sql, id, reason) {
  return sql.query(
    `INSERT INTO deleted_people (person_id, data, child_links, spouses, reason)
     SELECT p.id, to_jsonb(p),
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'role', CASE WHEN c.father_id = p.id THEN 'father' ELSE 'mother' END))
                 FROM people c WHERE c.father_id = p.id OR c.mother_id = p.id), '[]'::jsonb),
       COALESCE((SELECT array_agg(CASE WHEN m.a_id = p.id THEN m.b_id ELSE m.a_id END)
                 FROM marriages m WHERE m.a_id = p.id OR m.b_id = p.id), '{}'),
       $2
     FROM people p WHERE p.id = $1`, [id, reason]);
}

// Would making `parentId` a parent of `childId` create a loop (someone being their own ancestor)?
export async function wouldCreateLoop(sql, childId, parentId) {
  if (childId === parentId) return true;
  const rows = await sql.query(
    `WITH RECURSIVE d AS (
       SELECT id FROM people WHERE father_id = $1 OR mother_id = $1
       UNION
       SELECT p.id FROM people p JOIN d ON p.father_id = d.id OR p.mother_id = d.id
     ) SELECT 1 FROM d WHERE id = $2 LIMIT 1`, [childId, parentId]);
  return rows.length > 0;
}

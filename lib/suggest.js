import { nameTokens, sameName } from './names.js';

// Build review questions from names, list order and what has already been confirmed.
//   people:    [{ id, name, birthYear, city, position, inDirectory, fatherId, motherId }]
//   marriages: [[aId, bId]]
//   decisions: [{ kind, personId, candidate, decision }]
export function buildSuggestions({ people, marriages, decisions }) {
  const P = people.map((p) => ({ ...p, ...nameTokens(p.name) }));
  const byId = new Map(P.map((p) => [p.id, p]));
  const answered = new Set(decisions.map((d) => `${d.kind}|${d.personId}|${d.candidate}`));
  const isAnswered = (kind, personId, candidate) => answered.has(`${kind}|${personId}|${candidate}`);
  const married = new Set(marriages.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));

  const byGiven = new Map();
  for (const p of P) if (p.t[0]) (byGiven.get(p.t[0]) ?? byGiven.set(p.t[0], []).get(p.t[0])).push(p);

  const brief = (p) => ({ id: p.id, name: p.name, city: p.city, birthYear: p.birthYear, inDirectory: p.inDirectory });
  const parentAgeOk = (parent, child) => {
    if (!parent.birthYear || !child.birthYear) return true;
    const gap = child.birthYear - parent.birthYear;
    return gap >= 15 && gap <= 65;
  };

  // The third name is usually the grandfather, but some branches use it as a family name
  // ("Hussain Abdullah Sikander" is the son of "Abdullah Hussain Sikander").
  const fatherNameFits = (q, c) =>
    c.t.length < 3 || q.t.length < 2 || sameName(q.t[1], c.t[2]) || sameName(q.t.at(-1), c.t.at(-1));

  const cards = { father: [], spouse: [], ancestor: [], mother: [] };

  // 1. Fathers: someone whose own name is this person's second name, with a matching grandfather name.
  const hasFatherCandidates = new Set();
  for (const c of P) {
    if (c.fatherId || c.t.length < 2 || isAnswered('father', c.id, '*')) continue;
    const candidates = (byGiven.get(c.t[1]) || []).filter((q) =>
      q.id !== c.id &&
      q.id !== c.motherId &&
      fatherNameFits(q, c) &&
      parentAgeOk(q, c) &&
      !married.has(`${c.id}|${q.id}`) &&
      !isAnswered('father', c.id, String(q.id)));
    if (candidates.length) {
      hasFatherCandidates.add(c.id);
      cards.father.push({ type: 'father', key: `father-${c.id}`, person: brief(c), candidates: candidates.map(brief) });
    }
  }

  // 2. Marriages, from the list order (husband, then wife, then children) and wives named after husbands.
  const seenPairs = new Set();
  const isChildByName = (k, x) => k.t[1] === x.t[0];
  const areSiblingsByName = (x, y) => x.t.length >= 3 && y.t.length >= 3 && x.t[1] === y.t[1] && sameName(x.t[2], y.t[2]);
  const hasChildrenByName = (x) => x.t.length >= 2 && P.some((k) =>
    k !== x && k.t.length >= 3 && k.t[1] === x.t[0] && fatherNameFits(x, k) && parentAgeOk(x, k));
  // Wives are often listed as "Name Husband" or "Name Husband Surname".
  const looksNamedAfterHusband = (y, x) => y.t[1] === x.t[0] && (y.t.length === 2 ||
    (y.birthYear && x.birthYear && Math.abs(y.birthYear - x.birthYear) < 15 && sameName(y.t.at(-1), x.t.at(-1))));
  const addSpouse = (x, y, reason) => {
    const [a, b] = x.id < y.id ? [x, y] : [y, x];
    const pair = `${a.id}|${b.id}`;
    if (seenPairs.has(pair) || married.has(pair) || isAnswered('spouse', a.id, String(b.id))) return;
    if ([a.fatherId, a.motherId].includes(b.id) || [b.fatherId, b.motherId].includes(a.id)) return;
    if (a.fatherId && a.fatherId === b.fatherId) return;
    if (a.birthYear && b.birthYear && Math.abs(a.birthYear - b.birthYear) > 25) return;
    seenPairs.add(pair);
    cards.spouse.push({ type: 'spouse', key: `spouse-${pair}`, a: brief(a), b: brief(b), reason });
  };

  const directoryByCity = new Map();
  for (const p of P) if (p.inDirectory && p.city) (directoryByCity.get(p.city) ?? directoryByCity.set(p.city, []).get(p.city)).push(p);
  for (const list of directoryByCity.values()) {
    list.sort((a, b) => a.position - b.position);
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      // Wife listed as "Name Husband", within two rows of him.
      for (let j = Math.max(0, i - 2); j <= Math.min(list.length - 1, i + 2); j++) {
        const y = list[j];
        if (y !== x && looksNamedAfterHusband(y, x)) addSpouse(x, y, `${y.name}'s second name is ${x.orig[0]}, and they are listed close together`);
      }
      const y = list[i + 1];
      if (!y || areSiblingsByName(x, y) || (isChildByName(y, x) && !looksNamedAfterHusband(y, x)) || isChildByName(x, y)) continue;
      if (hasChildrenByName(x)) addSpouse(x, y, `${y.name} is listed straight after ${x.name}, before their children`);
    }
  }

  // 3. Ancestors not in the list: group people whose names point to the same missing father.
  const groups = new Map();
  for (const c of P) {
    if (c.fatherId || hasFatherCandidates.has(c.id) || isAnswered('father', c.id, '*')) continue;
    if (c.t.length < (c.inDirectory ? 3 : 2)) continue;
    const key = c.t.slice(1, 3).join(' ');
    if (isAnswered('ancestor', c.id, key) || isAnswered('ancestor', c.id, '*')) continue;
    if (!groups.has(key)) groups.set(key, { type: 'ancestor', key: `ancestor-${key}`, nameKey: key, name: c.orig.slice(1, 3).join(' '), children: [] });
    groups.get(key).children.push(brief(c));
  }
  cards.ancestor = [...groups.values()].sort((a, b) => b.children.length - a.children.length);

  // 4. Mothers: once a marriage is confirmed, ask about the husband's children.
  for (const [a, b] of marriages) {
    for (const [h, w] of [[a, b], [b, a]]) {
      const kids = P.filter((k) => k.fatherId === h && !k.motherId && k.id !== w &&
        !isAnswered('mother', k.id, String(w)) && !isAnswered('mother', k.id, '*'));
      if (kids.length && byId.get(w)) {
        cards.mother.push({ type: 'mother', key: `mother-${h}-${w}`, mother: brief(byId.get(w)), father: brief(byId.get(h)), children: kids.map(brief) });
      }
    }
  }

  return [...cards.father, ...cards.spouse, ...cards.mother, ...cards.ancestor];
}

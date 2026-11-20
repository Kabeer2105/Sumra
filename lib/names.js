// Name handling for family matching. Names in Sumra follow:
//   own name, father's name, grandfather's name   e.g. "Reyah Yasir Abdulgany"

const INVISIBLE = /[​-‍⁠﻿]/g;

export const cleanName = (s) => String(s ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

// Fold common spelling differences so "Walimohammed" matches "Walimohamed", "Essack" matches "Essak".
export function normToken(word) {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  s = s.replace(/m[ou]hamm?[ae]d/g, 'mohamed');
  s = s.replace(/ck/g, 'k').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/ei/g, 'e').replace(/ph/g, 'f');
  return s.replace(/(.)\1+/g, '$1');
}

// Split a name into normalised tokens. "Abdul Karim" counts as one name.
export function nameTokens(name) {
  const words = cleanName(name).split(' ').filter(Boolean);
  const t = [];
  const orig = [];
  for (let i = 0; i < words.length; i++) {
    let n = normToken(words[i]);
    let o = words[i];
    if (n === 'abdul' && i + 1 < words.length) {
      n += normToken(words[i + 1]);
      o += ' ' + words[i + 1];
      i++;
    }
    if (n) { t.push(n); orig.push(o); }
  }
  return { t, orig };
}

// "Karim" and "Abdul Karim" are treated as the same grandfather name.
export const sameName = (a, b) => a === b || a === 'abdul' + b || b === 'abdul' + a;

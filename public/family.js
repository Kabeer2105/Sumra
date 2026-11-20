(() => {
  const { api, el, formatDate, formatLoose, parseLooseDate, cityLabel, citySelect, BLOOD_GROUPS } = window.Sumra;
  const directoryView = document.getElementById('directoryView');
  const view = document.getElementById('familyView');
  const cityTabs = document.getElementById('cities');
  const reviewCount = document.getElementById('reviewCount');

  // ---------- data ----------
  let data = null;
  let loading = null;

  async function getData() {
    if (data) return data;
    if (!loading) {
      loading = api('/api/family').then((raw) => {
        const byId = new Map(raw.people.map((p) => [p.id, p]));
        const childrenOf = new Map();
        const spousesOf = new Map();
        const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
        for (const p of raw.people) {
          if (p.fatherId) push(childrenOf, p.fatherId, p.id);
          if (p.motherId) push(childrenOf, p.motherId, p.id);
        }
        for (const [a, b] of raw.marriages) { push(spousesOf, a, b); push(spousesOf, b, a); }
        data = { ...raw, byId, childrenOf, spousesOf };
        return data;
      }).finally(() => { loading = null; });
    }
    return loading;
  }

  function invalidate() {
    data = null;
    refreshReviewCount();
    renderBirthdays();
  }
  window.SumraFamily = { invalidate };

  const kids = (id) => data.childrenOf.get(id) || [];
  const spouses = (id) => data.spousesOf.get(id) || [];
  const person = (id) => data.byId.get(id);

  function descendants(id) {
    const seen = new Set();
    const stack = [...kids(id)];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k) || k === id) continue;
      seen.add(k);
      stack.push(...kids(k));
    }
    return seen;
  }

  // Age now, or at death. "about" when only years are known.
  function ageText(pr) {
    if (!pr.birthYear) return '';
    const end = pr.deceased ? (pr.deathDate ? new Date(`${pr.deathDate}T00:00:00`) : pr.deathYear ? null : undefined) : new Date();
    if (end === undefined) return ''; // passed away, year unknown
    if (end === null || !pr.birthdate) {
      const endYear = end ? end.getFullYear() : pr.deathYear;
      return `about ${endYear - pr.birthYear}`;
    }
    const [y, m, d] = pr.birthdate.split('-').map(Number);
    let age = end.getFullYear() - y;
    if (end.getMonth() + 1 < m || (end.getMonth() + 1 === m && end.getDate() < d)) age--;
    return String(age);
  }

  // "1943–2010", "born 1943", "passed away 2010", "passed away" or ''.
  function lifeSpan(pr) {
    const b = pr.birthYear, d = pr.deathYear;
    if (pr.deceased) return b && d ? `${b}–${d}` : b ? `${b}, passed away` : d ? `passed away ${d}` : 'passed away';
    return b ? `born ${b}` : '';
  }

  // ---------- small view helpers ----------
  const h = (level, text, props = {}) => el(`h${level}`, { textContent: text, ...props });
  const p = (text, className = '') => el('p', { textContent: text, className });
  const button = (label, onclick, className = 'btn') => el('button', { type: 'button', className, textContent: label, onclick });
  const link = (href, text, className = '') => el('a', { href, textContent: text, className });

  function describe(pr) {
    const parts = [];
    const span = lifeSpan(pr);
    if (span) parts.push(span);
    parts.push(pr.inDirectory ? cityLabel(pr.city) : 'family tree only');
    return parts.join(', ');
  }

  function personLink(id, extra = '') {
    const pr = person(id);
    if (!pr) return el('span', { textContent: 'Unknown' });
    return el('span', { className: 'plink' }, [
      link(`#/person/${pr.id}`, pr.name || 'Unnamed'),
      el('span', { className: 'plink-meta', textContent: ` ${describe(pr)}${extra}` }),
    ]);
  }

  function showError(err) {
    view.replaceChildren(p(`Couldn't load the family data: ${err.message}. Check your connection and reload the page.`, 'status error'));
  }

  async function save(fn) {
    try {
      await fn();
      invalidate();
      window.Sumra.reload();
      route();
    } catch (err) {
      alert(`Couldn't save: ${err.message}`);
    }
  }

  // ---------- person picker ----------
  const picker = document.getElementById('picker');
  const pickerSearch = document.getElementById('pickerSearch');
  const pickerResults = document.getElementById('pickerResults');
  const pickerTitle = document.getElementById('pickerTitle');
  const pickerAdd = document.getElementById('pickerAddAncestor');

  function pickPerson(title, { exclude = [] } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => { if (!done) { done = true; resolve(id); if (picker.open) picker.close(); } };
      pickerTitle.textContent = title;
      pickerSearch.value = '';
      const renderResults = () => {
        const q = pickerSearch.value.trim().toLowerCase();
        const matches = q ? data.people.filter((x) => !exclude.includes(x.id) && x.name.toLowerCase().includes(q)).slice(0, 40) : [];
        pickerResults.replaceChildren(...matches.map((x) =>
          el('li', {}, [el('button', { type: 'button', className: 'pick', onclick: () => finish(x.id) }, [
            el('span', { className: 'pick-name', textContent: x.name }),
            el('span', { className: 'plink-meta', textContent: describe(x) }),
          ])])));
        if (q && !matches.length) pickerResults.append(el('li', { className: 'picker-empty', textContent: `No one called “${pickerSearch.value.trim()}” yet.` }));
        pickerAdd.hidden = !q;
        pickerAdd.textContent = `Add “${pickerSearch.value.trim()}” as an ancestor`;
      };
      pickerSearch.oninput = renderResults;
      pickerAdd.onclick = async () => {
        try {
          const created = await api('/api/ancestors', { method: 'POST', body: JSON.stringify({ name: pickerSearch.value }) });
          finish(created.id);
        } catch (err) { alert(err.message); }
      };
      picker.onclose = () => finish(null);
      renderResults();
      picker.showModal();
      pickerSearch.focus();
    });
  }

  // ---------- home ----------
  async function renderHome() {
    const d = await getData();
    const linked = d.people.filter((x) => x.fatherId || x.motherId).length;
    const roots = d.people
      .filter((x) => !x.fatherId && !x.motherId && kids(x.id).length)
      .map((x) => [x, descendants(x.id).size])
      .sort((a, b) => b[1] - a[1]);

    const search = el('input', { type: 'search', placeholder: 'Find a person', autocomplete: 'off' });
    const results = el('ul', { className: 'result-list' });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const found = q ? d.people.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 30) : [];
      results.replaceChildren(...found.map((x) => el('li', {}, [personLink(x.id)])));
      if (q && !found.length) results.append(el('li', { className: 'muted', textContent: 'No one by that name.' }));
    });

    const addSlot = el('div', { className: 'add-slot' });
    const deceasedCount = d.people.filter((x) => x.deceased).length;
    view.replaceChildren(
      h(2, 'Family'),
      p(`${linked} of ${d.people.length} people are linked to a parent, and ${d.marriages.length} marriages are recorded${deceasedCount ? `. ${deceasedCount} ${deceasedCount === 1 ? 'person has' : 'people have'} passed away` : ''}. Open anyone's card to see their parents, spouse, brothers and sisters, and children.`, 'lead'),
      el('div', { className: 'home-actions' }, [
        el('label', { className: 'search grow' }, [el('span', { className: 'visually-hidden', textContent: 'Find a person' }), search]),
        link('#/relate', 'How are we related?', 'btn'),
        button('Add someone to the tree', () => {
          if (addSlot.firstChild) { addSlot.replaceChildren(); return; }
          addSlot.replaceChildren(personForm({ onCancel: () => addSlot.replaceChildren() }));
          addSlot.querySelector('input')?.focus();
        }),
        link('#/review', 'Review suggestions', 'btn primary'),
      ]),
      addSlot,
      results,
      h(3, 'Family branches'),
      roots.length
        ? el('ul', { className: 'branch-list' }, roots.map(([x, n]) => el('li', {}, [
          link(`#/branch/${x.id}`, x.name, 'branch-name'),
          el('span', { className: 'plink-meta', textContent: ` ${n} descendant${n === 1 ? '' : 's'}` }),
        ])))
        : p('No branches yet. Answer a few questions in Review and the branches will start to appear here.', 'muted'),
      el('p', { className: 'muted home-foot' }, [
        link('#/missing', 'Find double entries'), ' or see ', link('#/deleted', 'recently deleted'), ' people.',
      ]),
    );
    search.focus();
  }

  // ---------- person card ----------
  async function renderPerson(id) {
    await getData();
    const pr = person(id);
    if (!pr) { view.replaceChildren(p('This person is no longer in the list.', 'status error'), link('#/family', 'Back to Family')); return; }

    const siblings = [...new Set([pr.fatherId, pr.motherId].filter(Boolean).flatMap((pid) => kids(pid)))].filter((x) => x !== id);
    const children = kids(id);
    const age = ageText(pr);
    const editSlot = el('div', { id: 'editSlot' });

    const parentRow = (label, key) => {
      const pid = pr[key];
      return row(label, pid ? [personLink(pid)] : [el('span', { className: 'muted', textContent: 'Not recorded' })], [
        button(pid ? 'Change' : 'Set', () => setParent(key, label.toLowerCase()), 'btn quiet'),
        ...(pid ? [button('Remove', () => confirm(`Remove ${person(pid).name} as ${pr.name}'s ${label.toLowerCase()}?`) &&
          save(() => api(`/api/people/${id}/parents`, { method: 'PUT', body: JSON.stringify({ [key]: null }) })), 'btn quiet')] : []),
      ]);
    };

    const setParent = async (key, word) => {
      const pid = await pickPerson(`Choose ${pr.name}'s ${word}`, { exclude: [id] });
      if (pid) save(() => api(`/api/people/${id}/parents`, { method: 'PUT', body: JSON.stringify({ [key]: pid }) }));
    };

    const addSpouse = async () => {
      const sid = await pickPerson(`Who is ${pr.name} married to?`, { exclude: [id, ...spouses(id)] });
      if (sid) save(() => api('/api/marriages', { method: 'POST', body: JSON.stringify({ a: id, b: sid }) }));
    };

    // The tree doesn't store anyone's gender, so ask which parent this person is.
    const addChild = async () => {
      const cid = await pickPerson(`Add a child of ${pr.name}`, { exclude: [id, ...children] });
      if (!cid) return;
      const child = person(cid);
      const asParent = (key) => {
        const existing = child[key];
        if (existing && existing !== id && !confirm(`${child.name} already has ${person(existing).name} as ${key === 'fatherId' ? 'father' : 'mother'}. Replace with ${pr.name}?`)) return;
        save(() => api(`/api/people/${cid}/parents`, { method: 'PUT', body: JSON.stringify({ [key]: id }) }));
      };
      editSlot.replaceChildren(el('div', { className: 'card choice' }, [
        p(`Is ${pr.name} ${child.name}'s father or mother?`, 'big'),
        el('div', { className: 'form-actions' }, [
          button('Father', () => asParent('fatherId'), 'btn primary'),
          button('Mother', () => asParent('motherId'), 'btn primary'),
          button('Cancel', () => editSlot.replaceChildren()),
        ]),
      ]));
    };

    const born = formatLoose(pr.birthdate, pr.birthYear);
    const died = formatLoose(pr.deathDate, pr.deathYear);
    const facts = [
      pr.inDirectory ? `Listed in ${cityLabel(pr.city)}` : 'In the family tree only',
      born && `Born ${born}${!pr.deceased && age ? ` (${age})` : ''}`,
      pr.deceased && `Passed away${died ? ` ${died}` : ''}${age ? `, aged ${age}` : ''}`,
      pr.bloodGroup && `Blood group ${pr.bloodGroup}`,
    ].filter(Boolean);

    view.replaceChildren(
      el('div', { className: 'person-head' }, [
        h(2, pr.name || 'Unnamed', { className: pr.deceased ? 'is-deceased' : '' }),
        el('ul', { className: 'facts' }, [
          ...facts.map((f) => el('li', { textContent: f })),
          ...(pr.contact && !pr.deceased ? [el('li', {}, [link(`tel:${pr.contact.replace(/[^\d+]/g, '')}`, pr.contact)])] : []),
        ]),
        ...(pr.notes ? [el('p', { className: 'notes', textContent: pr.notes })] : []),
        el('div', { className: 'person-actions' }, [
          button('Edit details', () => {
            if (editSlot.firstChild) { editSlot.replaceChildren(); return; }
            editSlot.replaceChildren(personForm({ person: pr, onCancel: () => editSlot.replaceChildren() }));
            editSlot.querySelector('input')?.focus();
          }),
          ...(children.length ? [link(`#/branch/${id}`, 'See all descendants', 'btn')] : []),
          link(`#/relate?a=${id}`, 'How are they related to…', 'btn'),
          button('Merge with a double entry', async () => {
            const other = await pickPerson(`Which entry is a double of ${pr.name}?`, { exclude: [id] });
            if (other) location.hash = `#/merge?a=${id}&b=${other}`;
          }, 'btn quiet'),
          button('Delete', () => {
            const sp = spouses(id).length;
            editSlot.replaceChildren(el('div', { className: 'card choice danger-zone' }, [
              p(`Delete ${pr.name}?`, 'big'),
              p([
                children.length ? `${children.length} ${children.length === 1 ? 'child loses' : 'children lose'} their link to ${pr.name}.` : '',
                sp ? `${sp} ${sp === 1 ? 'marriage is' : 'marriages are'} removed.` : '',
                'You can bring them back, links included, from Family, Recently deleted.',
                'If this is a double entry, Merge keeps the links and details from both instead.',
              ].filter(Boolean).join(' ')),
              el('div', { className: 'form-actions' }, [
                button('Delete', async () => {
                  try {
                    await api(`/api/people/${id}`, { method: 'DELETE' });
                    invalidate();
                    window.Sumra.reload();
                    location.hash = '#/deleted';
                  } catch (err) { alert(`Couldn't delete: ${err.message}`); }
                }, 'btn danger'),
                button('Cancel', () => editSlot.replaceChildren()),
              ]),
            ]));
          }, 'btn quiet danger-text'),
        ]),
        editSlot,
      ]),
      el('dl', { className: 'family-grid' }, [
        parentRow('Father', 'fatherId'),
        parentRow('Mother', 'motherId'),
        row(spouses(id).length > 1 ? 'Spouses' : 'Spouse',
          spouses(id).length ? spouses(id).map((s) => el('div', { className: 'with-action' }, [personLink(s),
            button('Remove', () => confirm(`Remove the marriage between ${pr.name} and ${person(s).name}?`) &&
              save(() => api(`/api/marriages?a=${id}&b=${s}`, { method: 'DELETE' })), 'btn quiet')]))
            : [el('span', { className: 'muted', textContent: 'Not recorded' })],
          [button('Add spouse', addSpouse, 'btn quiet')]),
        row('Brothers and sisters', siblings.length ? siblings.map((s) => personLink(s, halfNote(pr, person(s))))
          : [el('span', { className: 'muted', textContent: pr.fatherId || pr.motherId ? 'None recorded' : 'Set a parent to see them' })]),
        row('Children', children.length ? children.map((c) => personLink(c)) : [el('span', { className: 'muted', textContent: 'None recorded' })],
          [button('Add child', addChild, 'btn quiet')]),
      ]),
    );
  }

  function halfNote(a, b) {
    if (a.fatherId && a.motherId && b.fatherId && b.motherId && (a.fatherId !== b.fatherId || a.motherId !== b.motherId)) return ', half-sibling';
    return '';
  }

  function row(label, values, actions = []) {
    return el('div', { className: 'family-row' }, [
      el('dt', { textContent: label }),
      el('dd', {}, [el('div', { className: 'values' }, values), ...(actions.length ? [el('div', { className: 'row-tools' }, actions)] : [])]),
    ]);
  }

  // One form for adding someone to the tree and for editing anyone. Every field except the name is optional.
  function personForm({ person: pr = null, onCancel }) {
    const isNew = !pr;
    pr = pr || { name: '', deceased: false, city: null };
    const field = (label, input, hint) => el('label', { className: 'field' }, [label, input, ...(hint ? [el('span', { className: 'hint', textContent: hint })] : [])]);

    const name = el('input', { value: pr.name, required: true, autocomplete: 'off' });
    const born = el('input', { value: formatLoose(pr.birthdate, pr.birthYear), placeholder: 'e.g. 1943 or 3 Feb 1943', autocomplete: 'off' });
    const passed = el('input', { type: 'checkbox', checked: !!pr.deceased });
    const died = el('input', { value: formatLoose(pr.deathDate, pr.deathYear), placeholder: 'e.g. 2010 or 14 Mar 2010', autocomplete: 'off' });
    const contact = el('input', { type: 'tel', value: pr.contact || '', autocomplete: 'off' });
    const blood = el('select', {}, [el('option', { value: '', textContent: 'Unknown' }), ...BLOOD_GROUPS.map((g) => el('option', { value: g, textContent: g }))]);
    blood.value = pr.bloodGroup || '';
    const where = citySelect(pr.inDirectory === false ? '' : pr.city, { allowNone: true });
    const notes = el('textarea', { value: pr.notes || '', rows: 3, placeholder: 'Anything worth remembering: other names they were known by, where they lived or are buried, their work' });
    const error = el('p', { className: 'status error', role: 'alert' });

    const diedField = field('Passed away on', died, 'Leave empty if the date is not known');
    const cityHint = el('span', { className: 'hint' });
    const sync = () => {
      diedField.hidden = !passed.checked;
      cityHint.textContent = passed.checked && where.value
        ? `Still shown on the ${cityLabel(where.value)} list. Choose "Not on a city list" to keep them in the family tree only.`
        : !where.value ? 'Shown in the family tree, not on any city list.' : '';
    };
    passed.addEventListener('change', sync);
    where.addEventListener('change', sync);
    sync();

    const form = el('form', { className: 'edit-form card person-form' }, [
      el('p', { className: 'form-title', textContent: isNew ? 'Add someone to the family tree' : `Edit ${pr.name}` }),
      el('label', { className: 'field wide' }, ['Name', name]),
      field('Born', born, 'A year is enough if that is all anyone knows'),
      el('label', { className: 'check field-check' }, [passed, 'Has passed away']),
      diedField,
      field('Contact', contact),
      field('Blood group', blood),
      el('label', { className: 'field wide' }, ['City list', where, cityHint]),
      el('label', { className: 'field wide' }, ['Notes', notes]),
      error,
      el('div', { className: 'form-actions' }, [
        el('button', { type: 'submit', className: 'btn primary', textContent: isNew ? 'Add to the family tree' : 'Save changes' }),
        button('Cancel', onCancel),
      ]),
    ]);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = 'Enter a name.'; name.focus(); return; }
      const b = parseLooseDate(born.value);
      if (b.error) { error.textContent = `Born: ${b.error}`; born.focus(); return; }
      const dd = passed.checked ? parseLooseDate(died.value) : { date: '', year: null };
      if (dd.error) { error.textContent = `Passed away: ${dd.error}`; died.focus(); return; }
      if (b.year && dd.year && dd.year < b.year) { error.textContent = 'The date of passing is before the birth date.'; return; }

      const body = {
        name: name.value, birthdate: b.date, birthYear: b.year,
        deceased: passed.checked, deathDate: dd.date, deathYear: dd.year,
        contact: contact.value, bloodGroup: blood.value, notes: notes.value,
      };
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      try {
        if (isNew) {
          const created = where.value
            ? await api('/api/people', { method: 'POST', body: JSON.stringify({ ...body, city: where.value }) })
            : await api('/api/ancestors', { method: 'POST', body: JSON.stringify(body) });
          invalidate();
          window.Sumra.reload();
          location.hash = `#/person/${created.id}`;
        } else {
          const newCity = where.value || null;
          if (newCity !== (pr.inDirectory ? pr.city : null)) body.city = newCity;
          await save(() => api(`/api/people/${pr.id}`, { method: 'PUT', body: JSON.stringify(body) }));
        }
      } catch (err) {
        error.textContent = `Couldn't save: ${err.message}`;
        submit.disabled = false;
      }
    });
    return form;
  }

  // ---------- branch (descendants) ----------
  async function renderBranch(id) {
    await getData();
    const root = person(id);
    if (!root) { view.replaceChildren(p('This person is no longer in the list.', 'status error')); return; }
    const inBranch = descendants(id);
    inBranch.add(id);
    const shown = new Set();

    // A child appears once: under the father, or under the mother when the father is not in this branch.
    const childrenHere = (pid) => kids(pid).filter((k) => {
      const c = person(k);
      if (c.fatherId === pid) return true;
      return !(c.fatherId && inBranch.has(c.fatherId));
    });

    const node = (pid, depth) => {
      shown.add(pid);
      const pr = person(pid);
      const sp = spouses(pid).map((s) => el('span', { className: 'spouse-chip' }, [
        'married to ', link(`#/person/${s}`, person(s).name),
        ...(inBranch.has(s) ? [el('span', { className: 'also', textContent: ' (also in this family)' })] : []),
      ]));
      const label = el('div', { className: 'tree-label' }, [
        link(`#/person/${pid}`, pr.name || 'Unnamed', 'tree-name'),
        lifeSpan(pr) ? el('span', { className: 'plink-meta', textContent: ` ${lifeSpan(pr)}` }) : '',
        ...sp,
      ]);
      const ch = childrenHere(pid).filter((k) => !shown.has(k))
        .sort((a, b) => (person(a).birthdate || '9999').localeCompare(person(b).birthdate || '9999'));
      const elsewhere = kids(pid).length && !childrenHere(pid).length
        ? el('div', { className: 'plink-meta', textContent: 'Children are shown under their father.' }) : '';
      if (!ch.length) return el('li', {}, [label, elsewhere]);
      const det = el('details', { open: depth < 2 }, [
        el('summary', {}, [label, el('span', { className: 'count-pill', textContent: `${ch.length} child${ch.length === 1 ? '' : 'ren'}` })]),
        el('ul', {}, ch.map((k) => node(k, depth + 1))),
      ]);
      return el('li', {}, [det]);
    };

    view.replaceChildren(
      h(2, `Descendants of ${root.name}`),
      p(`${inBranch.size - 1} people. Tap a name to open their card.`, 'lead'),
      el('div', { className: 'tree-tools' }, [
        button('Open all', () => view.querySelectorAll('.tree details').forEach((x) => { x.open = true; })),
        button('Close all', () => view.querySelectorAll('.tree details').forEach((x) => { x.open = false; })),
      ]),
      el('ul', { className: 'tree' }, [node(id, 0)]),
    );
  }

  // ---------- how are we related ----------
  function ancestorMap(id) {
    const map = new Map([[id, { depth: 0, from: null }]]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      const pr = person(cur);
      for (const par of [pr.fatherId, pr.motherId]) {
        if (par && !map.has(par)) { map.set(par, { depth: map.get(cur).depth + 1, from: cur }); queue.push(par); }
      }
    }
    return map;
  }

  function relationWord(da, db) {
    const greats = (n) => 'great-'.repeat(Math.max(0, n));
    if (da === 0) return db === 1 ? 'parent' : `${greats(db - 2)}grandparent`;
    if (db === 0) return da === 1 ? 'child' : `${greats(da - 2)}grandchild`;
    if (da === 1 && db === 1) return 'brother or sister';
    if (da === 1) return `${greats(db - 2)}uncle or aunt`;
    if (db === 1) return `${greats(da - 2)}nephew or niece`;
    const degree = Math.min(da, db) - 1;
    const removed = Math.abs(da - db);
    const ord = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][degree - 1] || `${degree}th`;
    return `${ord} cousin${removed === 0 ? '' : removed === 1 ? ' once removed' : removed === 2 ? ' twice removed' : ` ${removed} times removed`}`;
  }

  // Blood relations between a and b: one entry per closest shared ancestor (couples counted once).
  function bloodRelations(a, b) {
    const A = ancestorMap(a), B = ancestorMap(b);
    const common = [...A.keys()].filter((x) => B.has(x));
    const lowest = common.filter((c) => !kids(c).some((k) => common.includes(k)));
    const groups = [];
    const used = new Set();
    for (const c of lowest) {
      if (used.has(c)) continue;
      const partner = spouses(c).find((s) => lowest.includes(s) && !used.has(s) && A.get(s).depth === A.get(c).depth && B.get(s).depth === B.get(c).depth);
      used.add(c);
      if (partner) used.add(partner);
      groups.push({ ancestors: partner ? [c, partner] : [c], da: A.get(c).depth, db: B.get(c).depth, pathA: chain(A, c), pathB: chain(B, c) });
    }
    return groups.sort((x, y) => (x.da + x.db) - (y.da + y.db));
  }

  // From an ancestor back down to the starting person.
  function chain(map, top) {
    const out = [];
    for (let cur = top; cur != null; cur = map.get(cur).from) out.push(cur);
    return out.reverse();
  }

  function sentence(a, b, g) {
    const A = person(a).name, B = person(b).name;
    const word = relationWord(g.da, g.db);
    if (g.da === 1 && g.db === 1) return g.ancestors.length === 1 && person(a).fatherId && person(a).motherId && person(b).fatherId && person(b).motherId
      ? `${A} and ${B} are half-brothers or half-sisters.` : `${A} and ${B} are brothers or sisters.`;
    if (g.da >= 2 && g.db >= 2 && g.da === g.db) return `${A} and ${B} are ${word}s.`;
    return `${A} is ${B}'s ${word}.`;
  }

  async function renderRelate(params) {
    await getData();
    let a = Number(params.get('a')) || null;
    let b = Number(params.get('b')) || null;
    if (a && !person(a)) a = null;
    if (b && !person(b)) b = null;

    const choose = async (which) => {
      const id = await pickPerson(which === 'a' ? 'Choose the first person' : 'Choose the second person');
      if (!id) return;
      const next = new URLSearchParams({ ...(a ? { a } : {}), ...(b ? { b } : {}), [which]: id });
      location.hash = `#/relate?${next}`;
    };

    const slot = (which, id) => el('div', { className: 'relate-slot' }, [
      el('span', { className: 'muted', textContent: which === 'a' ? 'First person' : 'Second person' }),
      id ? personLink(id) : el('span', { className: 'muted', textContent: 'Not chosen' }),
      button(id ? 'Change' : 'Choose', () => choose(which), id ? 'btn quiet' : 'btn primary'),
    ]);

    const out = [h(2, 'How are we related?'), el('div', { className: 'relate-pick' }, [slot('a', a), slot('b', b)])];

    if (a && b) {
      const result = el('div', { className: 'card relate-result' });
      const lines = [];
      if (a === b) lines.push(p('That is the same person.'));
      if (spouses(a).includes(b)) lines.push(el('p', { className: 'big' }, [`${person(a).name} and ${person(b).name} are married.`]));

      const groups = a === b ? [] : bloodRelations(a, b);
      groups.forEach((g, i) => {
        if (i === 1) lines.push(h(3, 'They are also related another way'));
        lines.push(el('p', { className: i === 0 ? 'big' : '' }, [sentence(a, b, g)]));
        if (g.da === 0 || g.db === 0) {
          const line = g.da === 0 ? g.pathB : g.pathA; // ancestor ... descendant
          lines.push(el('p', { className: 'muted path' }, ['Line of descent, from the older generation down:']));
          lines.push(el('ol', { className: 'path-side' }, line.map((x) => el('li', {}, [link(`#/person/${x}`, person(x).name)]))));
        } else {
          lines.push(el('p', { className: 'path' }, [
            g.ancestors.length > 1 ? 'Closest shared ancestors: ' : 'Closest shared ancestor: ',
            ...g.ancestors.flatMap((x, j) => [j ? ' and ' : '', link(`#/person/${x}`, person(x).name)]),
          ]));
          lines.push(pathList(a, b, g.pathA, g.pathB));
        }
      });

      if (!groups.length && a !== b) {
        // Related by marriage: one step through a spouse.
        const viaSpouse = [];
        for (const [x, y] of [[a, b], [b, a]]) {
          for (const s of spouses(x)) {
            if (s === y) continue;
            const g = bloodRelations(s, y)[0];
            if (g) viaSpouse.push(`${person(x).name} is married to ${person(s).name}. ${sentence(s, y, g)}`);
          }
        }
        if (viaSpouse.length) viaSpouse.forEach((t, i) => lines.push(p(t, i === 0 ? 'big' : '')));
        else if (!spouses(a).includes(b)) lines.push(p('No connection found yet. More of the tree needs filling in: answer the questions in Review, or set parents on their cards.'));
      }
      result.replaceChildren(...lines);
      out.push(result);
    }
    view.replaceChildren(...out);
  }

  function pathList(a, b, pathA, pathB) {
    // pathA: ancestor ... a, pathB: ancestor ... b
    const side = (who, path) => el('div', {}, [
      el('p', { className: 'muted path', textContent: `Down to ${person(who).name}` }),
      el('ol', { className: 'path-side' }, path.slice(1).map((x) => el('li', {}, [link(`#/person/${x}`, person(x).name)]))),
    ]);
    return el('div', { className: 'path-cols' }, [side(a, pathA), side(b, pathB)]);
  }

  // ---------- review ----------
  async function refreshReviewCount() {
    try {
      const r = await api('/api/suggestions');
      reviewCount.textContent = r.cards.length || '';
      return r;
    } catch { return null; }
  }

  let reviewType = null;
  async function renderReview() {
    view.replaceChildren(h(2, 'Review suggestions'), p('Loading suggestions…', 'muted'));
    const r = await api('/api/suggestions');
    reviewCount.textContent = r.cards.length || '';
    await getData();

    const types = [['father', 'Fathers'], ['spouse', 'Marriages'], ['mother', 'Mothers'], ['ancestor', 'Missing ancestors']];
    const counts = Object.fromEntries(types.map(([t]) => [t, r.cards.filter((c) => c.type === t).length]));
    if (!reviewType || !counts[reviewType]) reviewType = types.find(([t]) => counts[t])?.[0] ?? 'father';
    const card = r.cards.find((c) => c.type === reviewType);

    const tabs = el('div', { className: 'chips review-tabs' }, types.map(([t, label]) => {
      const b = el('button', { type: 'button', className: 'chip all', onclick: () => { reviewType = t; renderReview(); } }, [label, el('span', { className: 'chip-n', textContent: counts[t] })]);
      b.setAttribute('aria-pressed', String(t === reviewType));
      return b;
    }));

    const intro = p(`The names suggest these family links. Each answer is saved straight away, and nothing is linked unless you say yes. You can always change a link later on the person's card. ${r.linked} of ${r.total} people are linked to a parent so far.`, 'lead');

    if (!r.cards.length) {
      view.replaceChildren(h(2, 'Review suggestions'), p('All done. There are no more suggestions right now.', 'big'),
        ...(r.unsure ? [p(`You skipped ${r.unsure} question${r.unsure === 1 ? '' : 's'} with Not sure.`), button('Ask the skipped questions again', () => decide({ type: 'reset-unsure' }), 'btn primary')] : []),
        el('p', {}, [link('#/family', 'Go to Family')]));
      return;
    }
    view.replaceChildren(h(2, 'Review suggestions'), intro, tabs, card ? renderCard(card) : p('Nothing left in this group.', 'muted'));
    view.querySelector('.review-card button')?.focus();
  }

  async function decide(payload) {
    view.querySelectorAll('.review-card button').forEach((b) => { b.disabled = true; });
    try {
      await api('/api/decide', { method: 'POST', body: JSON.stringify(payload) });
      data = null;
      window.Sumra.reload();
      renderBirthdays();
      await renderReview();
    } catch (err) {
      alert(`Couldn't save the answer: ${err.message}`);
      view.querySelectorAll('.review-card button').forEach((b) => { b.disabled = false; });
    }
  }

  const who = (b) => el('span', { className: 'plink' }, [
    link(`#/person/${b.id}`, b.name), el('span', { className: 'plink-meta', textContent: ` ${describe(person(b.id) || b)}` }),
  ]);

  function checklist(people) {
    const boxes = people.map((k) => {
      const cb = el('input', { type: 'checkbox', checked: true, value: k.id });
      return { id: k.id, cb, li: el('li', {}, [el('label', { className: 'check' }, [cb, who(k)])]) };
    });
    return { list: el('ul', { className: 'checklist' }, boxes.map((x) => x.li)), ticked: () => boxes.filter((x) => x.cb.checked).map((x) => x.id), unticked: () => boxes.filter((x) => !x.cb.checked).map((x) => x.id) };
  }

  function renderCard(c) {
    const card = el('section', { className: 'card review-card' });
    if (c.type === 'father') {
      card.append(
        h(3, `Who is ${c.person.name}'s father?`),
        el('p', {}, [who(c.person)]),
        el('ul', { className: 'cand-list' }, c.candidates.map((cand) => el('li', { className: 'cand' }, [
          who(cand),
          el('div', { className: 'cand-actions' }, [
            button('This is the father', () => decide({ type: 'father', personId: c.person.id, fatherId: cand.id }), 'btn primary'),
            button('They are married', () => decide({ type: 'father', personId: c.person.id, spouseId: cand.id }), 'btn'),
          ]),
        ]))),
        el('div', { className: 'card-foot' }, [
          button(c.candidates.length > 1 ? 'None of these' : 'No, not the father', () => decide({ type: 'father', personId: c.person.id, rejectIds: c.candidates.map((x) => x.id) })),
          button('Not sure, skip', () => decide({ type: 'father', personId: c.person.id, unsure: true }), 'btn quiet'),
        ]),
      );
    } else if (c.type === 'spouse') {
      card.append(
        h(3, `Are ${c.a.name} and ${c.b.name} married?`),
        el('ul', { className: 'plain' }, [el('li', {}, [who(c.a)]), el('li', {}, [who(c.b)])]),
        p(`Suggested because ${c.reason}.`, 'muted'),
        el('div', { className: 'card-foot' }, [
          button('Yes, married', () => decide({ type: 'spouse', a: c.a.id, b: c.b.id, answer: 'yes' }), 'btn primary'),
          button('No', () => decide({ type: 'spouse', a: c.a.id, b: c.b.id, answer: 'no' })),
          button('Not sure, skip', () => decide({ type: 'spouse', a: c.a.id, b: c.b.id, answer: 'unsure' }), 'btn quiet'),
        ]),
      );
    } else if (c.type === 'mother') {
      const cl = checklist(c.children);
      card.append(
        h(3, `Is ${c.mother.name} the mother of these children?`),
        p(`${c.mother.name} is married to ${c.father.name}, whose children are below. Untick anyone she is not the mother of.`, 'muted'),
        cl.list,
        el('div', { className: 'card-foot' }, [
          button('Save', () => decide({ type: 'mother', motherId: c.mother.id, acceptIds: cl.ticked(), rejectIds: cl.unticked() }), 'btn primary'),
          button('Not sure, skip', () => decide({ type: 'mother', motherId: c.mother.id, unsureIds: c.children.map((x) => x.id) }), 'btn quiet'),
        ]),
      );
    } else if (c.type === 'ancestor') {
      const cl = checklist(c.children);
      const nameInput = el('input', { value: c.name });
      card.append(
        h(3, `Add ${c.name} as their father?`),
        p(`${c.children.length === 1 ? 'This name says' : 'These names say'} the father was ${c.name}, who isn't in the list yet. Adding him puts him in the tree as an ancestor, not in the directory. Untick anyone who has a different father.`, 'muted'),
        cl.list,
        el('label', { className: 'field' }, ['Ancestor\'s name (fix the spelling if needed)', nameInput]),
        el('div', { className: 'card-foot' }, [
          button('Add and link the ticked people', () => decide({ type: 'ancestor', nameKey: c.nameKey, name: nameInput.value, acceptIds: cl.ticked(), rejectIds: cl.unticked() }), 'btn primary'),
          button('No', () => decide({ type: 'ancestor', nameKey: c.nameKey, rejectIds: c.children.map((x) => x.id) })),
          button('Not sure, skip', () => decide({ type: 'ancestor', nameKey: c.nameKey, unsureIds: c.children.map((x) => x.id) }), 'btn quiet'),
        ]),
      );
    }
    return card;
  }

  // ---------- double entries ----------
  // Same folding as the server's name matching, so "Mohammed"/"Mohamed" and "Abdul Karim"/"Abdulkarim" count as one.
  function normWord(w) {
    let s = w.toLowerCase().replace(/[^a-z]/g, '');
    s = s.replace(/m[ou]hamm?[ae]d/g, 'mohamed').replace(/ck/g, 'k').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u').replace(/ei/g, 'e').replace(/ph/g, 'f');
    return s.replace(/(.)\1+/g, '$1');
  }
  const nameKey = (name) => name.split(/\s+/).map(normWord).filter(Boolean).join(' ').replace(/\babdul /g, 'abdul');

  function duplicateGroups() {
    const groups = new Map();
    for (const x of data.people) {
      const k = nameKey(x.name);
      if (k) (groups.get(k) ?? groups.set(k, []).get(k)).push(x);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  const linkCount = (x) => kids(x.id).length + spouses(x.id).length + (x.fatherId ? 1 : 0) + (x.motherId ? 1 : 0);

  async function renderMerge(params) {
    await getData();
    const a = person(Number(params.get('a')));
    const b = person(Number(params.get('b')));
    if (!a || !b || a === b) { view.replaceChildren(p('Choose two different people to merge.', 'status error'), link('#/missing', 'Back')); return; }

    // Suggest keeping the entry on a city list, then the one with more links.
    let keep = (a.inDirectory !== b.inDirectory ? (a.inDirectory ? a : b) : linkCount(a) >= linkCount(b) ? a : b);
    const names = (ids) => ids.map((x) => person(x)?.name).filter(Boolean).join(', ');
    const rowsFor = (x) => ({
      Name: x.name,
      Born: formatLoose(x.birthdate, x.birthYear),
      'Passed away': x.deceased ? (formatLoose(x.deathDate, x.deathYear) || 'Yes, date not known') : '',
      Contact: x.contact,
      'Blood group': x.bloodGroup,
      'City list': x.inDirectory ? cityLabel(x.city) : '',
      Father: x.fatherId ? person(x.fatherId)?.name : '',
      Mother: x.motherId ? person(x.motherId)?.name : '',
      Spouse: names(spouses(x.id)),
      Children: names(kids(x.id)),
      Notes: x.notes,
    });
    const ra = rowsFor(a), rb = rowsFor(b);

    // Double entries usually share a name, so number them when they do.
    const sameName = a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
    const label = (x) => (sameName ? `entry ${x === a ? 1 : 2}` : x.name);
    const Label = (x) => label(x).charAt(0).toUpperCase() + label(x).slice(1);
    const pick = (x) => {
      const r = el('input', { type: 'radio', name: 'keep', checked: x === keep, onchange: () => { keep = x; draw(); } });
      return el('label', { className: 'check' }, [r, sameName ? `Keep entry ${x === a ? 1 : 2}` : `Keep ${x.name}`]);
    };
    const table = el('table', { className: 'compare' });
    const notes = el('ul', { className: 'merge-notes' });
    const draw = () => {
      const k = keep === a ? ra : rb, o = keep === a ? rb : ra;
      table.replaceChildren(
        el('thead', {}, [el('tr', {}, [el('th', {}), el('th', {}, [pick(a)]), el('th', {}, [pick(b)])])]),
        el('tbody', {}, Object.keys(ra).map((f) => {
          const clash = ra[f] && rb[f] && ra[f] !== rb[f] && !['Spouse', 'Children', 'Notes', 'Name'].includes(f);
          return el('tr', { className: clash ? 'clash' : '' }, [
            el('th', { textContent: f }),
            el('td', { textContent: ra[f] || '—', className: ra[f] ? '' : 'muted' }),
            el('td', { textContent: rb[f] || '—', className: rb[f] ? '' : 'muted' }),
          ]);
        })),
      );
      const other = keep === a ? b : a;
      const clashes = Object.keys(ra).filter((f) => k[f] && o[f] && k[f] !== o[f] && !['Spouse', 'Children', 'Notes', 'Name'].includes(f));
      notes.replaceChildren(
        el('li', { textContent: `${Label(keep)} stays. The children and marriages of ${label(other)} move to ${label(keep)}.` }),
        el('li', { textContent: `Details missing from ${label(keep)} are filled in from ${label(other)}. Notes from both are kept.` }),
        ...(clashes.length ? [el('li', { className: 'warn', textContent: `The two entries have a different ${clashes.map((c) => ({ Born: 'birth date', 'Passed away': 'date of passing', 'City list': 'city' }[c] || c.toLowerCase())).join(' and ')} (highlighted). The values from ${label(keep)} stay, so check them after merging.` })] : []),
        el('li', { textContent: `${Label(other)} then goes to Recently deleted. Restoring it brings the entry back, but the moved links stay with ${label(keep)}.` }),
      );
      mergeBtn.textContent = sameName ? `Merge into ${label(keep)}` : `Merge into ${keep.name}`;
    };
    const error = el('p', { className: 'status error' });
    const mergeBtn = button('Merge', async () => {
      mergeBtn.disabled = true;
      const other = keep === a ? b : a;
      try {
        await api(`/api/people/${keep.id}/merge`, { method: 'POST', body: JSON.stringify({ otherId: other.id }) });
        invalidate();
        window.Sumra.reload();
        location.hash = `#/person/${keep.id}`;
      } catch (err) { error.textContent = err.message; mergeBtn.disabled = false; }
    }, 'btn primary');

    view.replaceChildren(
      h(2, 'Merge a double entry'),
      p('Choose which entry to keep. Everything recorded on the other one is moved onto it.', 'lead'),
      el('div', { className: 'compare-wrap' }, [table]),
      notes, error,
      el('div', { className: 'form-actions' }, [mergeBtn, button('Cancel', () => history.back())]),
    );
    draw();
  }

  async function renderDeleted() {
    view.replaceChildren(h(2, 'Recently deleted'), p('Loading…', 'muted'));
    const rows = await api('/api/deleted');
    const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    view.replaceChildren(
      h(2, 'Recently deleted'),
      p('People who were deleted or merged into someone else. Restore brings them back with their parents, children and marriages, where those people still exist.', 'lead'),
      rows.length ? el('ul', { className: 'deleted-list' }, rows.map((r) => el('li', { className: 'card' }, [
        el('div', {}, [
          el('strong', { textContent: r.name }),
          el('div', { className: 'plink-meta', textContent: [
            r.reason === 'deleted' ? 'Deleted' : r.reason.charAt(0).toUpperCase() + r.reason.slice(1),
            when(r.deletedAt),
            r.inDirectory ? `was on the ${cityLabel(r.city)} list` : 'was in the family tree only',
            r.children ? `${r.children} child link${r.children === 1 ? '' : 's'}` : '',
            r.spouses ? `${r.spouses} marriage${r.spouses === 1 ? '' : 's'}` : '',
          ].filter(Boolean).join(', ') }),
        ]),
        button('Restore', async (e) => {
          e.target.disabled = true;
          try {
            const res = await api(`/api/deleted/${r.id}/restore`, { method: 'POST' });
            invalidate();
            window.Sumra.reload();
            location.hash = `#/person/${res.restoredId}`;
          } catch (err) { alert(`Couldn't restore: ${err.message}`); e.target.disabled = false; }
        }),
      ]))) : p('Nothing has been deleted.', 'muted'),
    );
  }

  // ---------- missing details ----------
  let missingType = 'birthdate';
  async function renderMissing() {
    const d = await getData();
    const dir = d.people.filter((x) => x.inDirectory);
    const checks = [
      ['birthdate', 'No birth year', (x) => !x.birthYear],
      ['contact', 'No contact', (x) => !x.contact && !x.deceased],
      ['blood', 'No blood group', (x) => !x.bloodGroup && !x.deceased],
      ['parents', 'No parent linked', (x) => !x.fatherId && !x.motherId],
    ];
    const dups = duplicateGroups();
    const tabs = el('div', { className: 'chips' }, [
      ...checks.map(([k, label, t]) => [k, label, dir.filter(t).length]),
      ['duplicates', 'Possible double entries', dups.length],
    ].map(([k, label, n]) => {
      const b = el('button', { type: 'button', className: 'chip all', onclick: () => { missingType = k; renderMissing(); } }, [label, el('span', { className: 'chip-n', textContent: n })]);
      b.setAttribute('aria-pressed', String(k === missingType));
      return b;
    }));
    const footer = el('p', { className: 'muted' }, ['Deleted or merged someone by mistake? ', link('#/deleted', 'See recently deleted'), '.']);

    if (missingType === 'duplicates') {
      view.replaceChildren(
        h(2, 'Missing details'),
        p('People with the same name, allowing for spelling differences like Mohammed and Mohamed. Some will be different people who share a name, so compare before merging.', 'lead'),
        tabs,
        ...(dups.length ? [el('ul', { className: 'dup-list' }, dups.map((g) => el('li', { className: 'card' }, [
          el('ul', { className: 'plain' }, g.map((x) => el('li', {}, [personLink(x.id, linkCount(x) ? `, ${linkCount(x)} family link${linkCount(x) === 1 ? '' : 's'}` : '')]))),
          ...(g.length === 2 ? [link(`#/merge?a=${g[0].id}&b=${g[1].id}`, 'Compare and merge', 'btn')]
            : [p('More than two entries: open one card and use Merge with a double entry for each extra one.', 'muted')]),
        ])))] : [p('No double entries found.', 'big')]),
        footer,
      );
      return;
    }

    const [, , test] = checks.find(([k]) => k === missingType);
    const missing = dir.filter(test);
    const byCity = new Map();
    for (const x of missing) (byCity.get(x.city) ?? byCity.set(x.city, []).get(x.city)).push(x);

    view.replaceChildren(
      h(2, 'Missing details'),
      p('People in the directory with gaps in their details. Open a card and use Edit details to fill them in.', 'lead'),
      tabs,
      ...(missing.length ? [...byCity].map(([c, list]) => el('section', { className: 'missing-city' }, [
        h(3, `${cityLabel(c)} (${list.length})`),
        el('ul', { className: 'result-list cols' }, list.map((x) => el('li', {}, [link(`#/person/${x.id}`, x.name)]))),
      ])) : [p('Nobody is missing this. Nice.', 'big')]),
      footer,
    );
  }

  // ---------- birthdays (directory page) ----------
  async function renderBirthdays() {
    const box = document.getElementById('birthdays');
    const listEl = document.getElementById('birthdayList');
    try {
      const d = await getData();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const upcoming = d.people.filter((x) => x.inDirectory && !x.deceased && x.birthdate).map((x) => {
        const [y, m, dd] = x.birthdate.split('-').map(Number);
        let next = new Date(today.getFullYear(), m - 1, dd);
        if (next < today) next = new Date(today.getFullYear() + 1, m - 1, dd);
        return { x, next, days: Math.round((next - today) / 86400000), turns: next.getFullYear() - y };
      }).filter((b) => b.days <= 30).sort((a, b) => a.days - b.days);

      box.hidden = !upcoming.length;
      const SHOW = 6;
      const item = (b) => el('li', { className: b.days === 0 ? 'today' : '' }, [
        el('span', { className: 'bday-date', textContent: b.days === 0 ? 'Today' : b.days === 1 ? 'Tomorrow' : b.next.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) }),
        el('span', { className: 'bday-who' }, [
          link(`#/person/${b.x.id}`, b.x.name),
          el('span', { className: 'plink-meta', textContent: `Turns ${b.turns}, ${cityLabel(b.x.city)}` }),
        ]),
      ]);
      const showSome = (all) => {
        listEl.replaceChildren(...(all ? upcoming : upcoming.slice(0, SHOW)).map(item));
        box.querySelector('.bday-more')?.remove();
        if (upcoming.length > SHOW) {
          box.append(button(all ? 'Show fewer' : `Show all ${upcoming.length}`, () => showSome(!all), 'btn quiet bday-more'));
        }
      };
      showSome(false);
    } catch { box.hidden = true; }
  }

  // ---------- router ----------
  async function route() {
    const [path, query = ''] = (location.hash || '#/').slice(1).split('?');
    const [, name = '', arg] = path.split('/');
    document.querySelectorAll('.main-nav a').forEach((a) => a.setAttribute('aria-current', String(
      a.dataset.nav === (name === '' ? 'directory' : ['person', 'branch', 'relate', 'merge', 'deleted'].includes(name) ? 'family' : name))));

    const isDirectory = name === '';
    directoryView.hidden = !isDirectory;
    cityTabs.hidden = !isDirectory;
    view.hidden = isDirectory;
    if (isDirectory) return;

    window.scrollTo(0, 0);
    try {
      await window.Sumra.ready; // city names are needed for labels
      if (name === 'person') await renderPerson(Number(arg));
      else if (name === 'branch') await renderBranch(Number(arg));
      else if (name === 'relate') await renderRelate(new URLSearchParams(query));
      else if (name === 'review') await renderReview();
      else if (name === 'missing') await renderMissing();
      else if (name === 'merge') await renderMerge(new URLSearchParams(query));
      else if (name === 'deleted') await renderDeleted();
      else await renderHome();
    } catch (err) {
      showError(err);
    }
  }

  window.addEventListener('hashchange', route);
  route();
  window.Sumra.ready.then(renderBirthdays);
  refreshReviewCount();
})();

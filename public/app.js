const API = '/api/people';
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Who a patient with each blood group can receive red cells from.
const DONORS_FOR = {
  'O-': ['O-'],
  'O+': ['O+', 'O-'],
  'A-': ['A-', 'O-'],
  'A+': ['A+', 'A-', 'O+', 'O-'],
  'B-': ['B-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'],
  'AB-': ['AB-', 'A-', 'B-', 'O-'],
  'AB+': ['AB+', 'AB-', 'A+', 'A-', 'B+', 'B-', 'O+', 'O-'],
};

const cityNav = document.getElementById('cities');
const list = document.getElementById('list');
const searchInput = document.getElementById('searchInput');
const statusEl = document.getElementById('status');
const bloodChips = document.getElementById('bloodChips');
const compatLabel = document.getElementById('compatLabel');
const compatToggle = document.getElementById('compatToggle');
let bloodFilter = ''; // '' = everyone
let cities = []; // [{ name, label, count }]
let city = localStorage.getItem('sumra.city');
let people = [];

compatToggle.addEventListener('change', applySearch);
searchInput.addEventListener('input', applySearch);
document.getElementById('addRowBtn').addEventListener('click', () => openForm({ mode: 'add' }));

// ---------- shared helpers ----------
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status error' : 'status';
}

const cityLabel = (c) => cities.find((x) => x.name === c)?.label || c || '';

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// A date that may only be partly known: show the full date, or just the year.
const formatLoose = (date, year) => (date ? formatDate(date) : year ? String(year) : '');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Read what someone typed for a date: "1943", "about 1943", "3/2/1943", "3 Feb 1943" or "1943-02-03".
// Returns { date: 'YYYY-MM-DD' | '', year: number | null } or { error }.
function parseLooseDate(text) {
  const s = String(text || '').trim().toLowerCase().replace(/^(about|abt\.?|around|approx\.?|c\.?|ca\.?|~)\s*/, '');
  if (!s) return { date: '', year: null };
  const thisYear = new Date().getFullYear();
  const okYear = (y) => y >= 1700 && y <= thisYear;
  const make = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (!okYear(y) || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { date: dt.toISOString().slice(0, 10), year: y };
  };
  let m;
  if ((m = s.match(/^(\d{4})$/))) return okYear(+m[1]) ? { date: '', year: +m[1] } : { error: `${m[1]} isn't a year between 1700 and ${thisYear}` };
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return make(+m[1], +m[2], +m[3]) || { error: `${text} isn't a real date` };
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) return make(+m[3], +m[2], +m[1]) || { error: `${text} isn't a real date (day/month/year)` };
  if ((m = s.match(/^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$/))) {
    const month = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    return (month && make(+m[3], month, +m[1])) || { error: `${text} isn't a real date` };
  }
  return { error: `Write a year like 1943, or a full date like 3 Feb 1943 or 3/2/1943` };
}

// ---------- cities ----------
async function loadCities() {
  try {
    cities = await api('/api/cities');
  } catch (err) {
    setStatus(`Couldn't load the cities: ${err.message}`, true);
    return;
  }
  if (!cities.some((c) => c.name === city)) city = cities[0]?.name;
  renderCityTabs();
}

function renderCityTabs() {
  const tabs = cities.map((c) => {
    const b = el('button', { type: 'button', onclick: () => selectCity(c.name) }, [
      el('span', { textContent: c.label }), el('span', { className: 'count', textContent: c.count }),
    ]);
    b.dataset.city = c.name;
    b.setAttribute('aria-pressed', String(c.name === city));
    return b;
  });
  cityNav.replaceChildren(...tabs, el('button', { type: 'button', className: 'add-city', textContent: '+ Add city', onclick: openCityDialog }));
}

function selectCity(name) {
  if (name === city) return;
  city = name;
  localStorage.setItem('sumra.city', city);
  searchInput.value = '';
  renderCityTabs();
  loadList();
}

const cityDialog = document.getElementById('cityDialog');
const cityInput = document.getElementById('cityName');
const cityError = document.getElementById('cityError');

function openCityDialog() {
  cityInput.value = '';
  cityError.textContent = '';
  cityDialog.showModal();
  cityInput.focus();
}

document.getElementById('cityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = cityInput.value.trim();
  if (!label) { cityError.textContent = 'Type the city name.'; return; }
  try {
    const created = await api('/api/cities', { method: 'POST', body: JSON.stringify({ label }) });
    cityDialog.close();
    await loadCities();
    selectCity(created.name);
    setStatus(`Added ${created.label}. Use Add person to add the first people.`);
  } catch (err) {
    cityError.textContent = err.message;
  }
});

// ---------- blood filter ----------
function renderBloodChips() {
  const tally = {};
  for (const p of people) if (p.bloodGroup) tally[p.bloodGroup] = (tally[p.bloodGroup] || 0) + 1;
  const chip = (value, label, n) => {
    const b = el('button', {
      type: 'button',
      className: value ? 'chip' : 'chip all',
      onclick: () => { bloodFilter = value; renderBloodChips(); applySearch(); },
    }, n === undefined ? [label] : [label, el('span', { className: 'chip-n', textContent: n })]);
    b.setAttribute('aria-pressed', String(bloodFilter === value));
    return b;
  };
  bloodChips.replaceChildren(chip('', 'Everyone'), ...BLOOD_GROUPS.map((g) => chip(g, g, tally[g] || 0)));
  compatLabel.hidden = !bloodFilter;
}

function matchesBlood(p) {
  if (!bloodFilter) return true;
  if (p.deceased) return false;
  const allowed = compatToggle.checked ? DONORS_FOR[bloodFilter] : [bloodFilter];
  return allowed.includes(p.bloodGroup);
}

// ---------- list ----------
async function loadList(flashId) {
  if (!city) return;
  const requested = city;
  setStatus('Loading…');
  try {
    const data = await api(`${API}?city=${encodeURIComponent(requested)}`);
    if (requested !== city) return; // switched city while loading
    people = data;
    render(flashId);
  } catch (err) {
    setStatus(`Couldn't load ${cityLabel(requested)}: ${err.message}. Check your connection and pick the city again.`, true);
  }
}

// Everything is inserted as text, never HTML, so names can't inject markup.
function viewRow(p, number) {
  const li = el('li', { className: p.deceased ? 'person deceased' : 'person' });
  li.dataset.id = p.id;
  li.dataset.name = (p.name || '').toLowerCase();

  const contact = p.contact
    ? el('a', { className: 'contact', href: `tel:${p.contact.replace(/[^\d+]/g, '')}`, textContent: p.contact })
    : el('span', { className: 'contact empty-value', textContent: 'No contact' });
  const born = formatLoose(p.birthdate, p.birthYear);

  li.append(
    el('span', { className: 'pos', textContent: number }),
    el('span', { className: 'name-cell' }, [
      el('a', { className: 'name', href: `#/person/${p.id}`, textContent: p.name || 'Unnamed', title: 'See family' }),
      ...(p.deceased ? [el('span', { className: 'passed-tag', textContent: `Passed away${p.deathYear ? ` ${p.deathYear}` : ''}` })] : []),
    ]),
    el('span', { className: born ? 'born' : 'born empty-value', textContent: born || 'No birthdate' }),
    contact,
    el('span', { className: p.bloodGroup ? 'blood' : 'blood none', textContent: p.bloodGroup || '—', title: p.bloodGroup ? `Blood group ${p.bloodGroup}` : 'Blood group not recorded' }),
    el('div', { className: 'row-actions' }, [
      el('button', { type: 'button', className: 'btn quiet', textContent: 'Edit', onclick: () => openForm({ mode: 'edit', person: p, row: li }) }),
      el('button', { type: 'button', className: 'btn quiet', textContent: 'Insert below', onclick: () => openForm({ mode: 'insert', after: p, row: li }) }),
    ]),
  );
  return li;
}

function render(flashId) {
  renderBloodChips();
  list.replaceChildren(...people.map((p, i) => viewRow(p, i + 1)));
  if (!people.length) {
    list.append(el('li', { className: 'empty', textContent: `No one in ${cityLabel(city)} yet. Use Add person to add the first.` }));
  }
  applySearch();
  if (flashId) list.querySelector(`[data-id="${flashId}"]`)?.classList.add('flash');
}

function field(label, input, wide = false) {
  return el('label', { className: wide ? 'field wide' : 'field' }, [label, input]);
}

function citySelect(current, { allowNone = false } = {}) {
  const sel = el('select', {}, [
    ...(allowNone ? [el('option', { value: '', textContent: 'Not on a city list' })] : []),
    ...cities.map((c) => el('option', { value: c.name, textContent: c.label })),
  ]);
  sel.value = current || '';
  return sel;
}

// One form at a time: add (end of list), insert (below a row) or edit (replace a row).
function openForm({ mode, person = {}, after, row }) {
  list.querySelector('.editing')?.cancel();

  const isEdit = mode === 'edit';
  const name = el('input', { value: person.name || '', autocomplete: 'off', required: true });
  const born = el('input', { value: formatLoose(person.birthdate, person.birthYear), placeholder: 'e.g. 3 Feb 1990 or 1990', autocomplete: 'off' });
  const contact = el('input', { type: 'tel', value: person.contact || '', autocomplete: 'off' });
  const blood = el('select', {}, [el('option', { value: '', textContent: 'Unknown' }), ...BLOOD_GROUPS.map((g) => el('option', { value: g, textContent: g }))]);
  if (person.bloodGroup && !BLOOD_GROUPS.includes(person.bloodGroup)) blood.append(el('option', { value: person.bloodGroup, textContent: person.bloodGroup }));
  blood.value = person.bloodGroup || '';
  const where = isEdit ? citySelect(person.city) : null;

  const title = isEdit ? `Edit ${person.name || 'person'}`
    : mode === 'insert' ? `New person below ${after.name || 'this row'}`
    : `New person in ${cityLabel(city)}`;

  const saveBtn = el('button', { type: 'submit', className: 'btn primary', textContent: isEdit ? 'Save changes' : 'Save person' });
  const form = el('form', { className: 'edit-form' }, [
    el('p', { className: 'form-title', textContent: title }),
    field('Name', name, true),
    field('Born', born),
    field('Contact', contact),
    field('Blood group', blood),
    ...(isEdit ? [field('City', where)] : []),
    el('div', { className: 'form-actions' }, [
      saveBtn,
      el('button', { type: 'button', className: 'btn', textContent: 'Cancel', onclick: () => li.cancel() }),
      ...(isEdit ? [el('a', { className: 'btn quiet', href: `#/person/${person.id}`, textContent: 'More details, passing away and family' })] : []),
    ]),
  ]);

  const li = el('li', { className: isEdit ? 'person editing' : 'person editing is-new' }, [form]);
  li.cancel = () => { if (isEdit) li.replaceWith(row); else li.remove(); };

  if (isEdit) row.replaceWith(li);
  else if (mode === 'insert') row.after(li);
  else { list.querySelector('.empty')?.remove(); list.append(li); }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) { name.focus(); setStatus('Enter a name before saving.', true); return; }
    const b = parseLooseDate(born.value);
    if (b.error) { born.focus(); setStatus(b.error, true); return; }
    saveBtn.disabled = true;
    const body = { name: name.value, birthdate: b.date, birthYear: b.year, contact: contact.value, bloodGroup: blood.value };
    const moving = isEdit && where.value !== person.city;
    if (moving) body.city = where.value;
    try {
      let saved;
      if (isEdit) saved = await api(`${API}/${person.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else saved = await api(API, { method: 'POST', body: JSON.stringify({ ...body, city, ...(mode === 'insert' ? { position: after.position + 1 } : {}) }) });
      await loadList(saved.id);
      if (!isEdit || moving) loadCities();
      window.SumraFamily?.invalidate();
      setStatus(moving ? `Moved ${saved.name} to ${cityLabel(saved.city)}.` : isEdit ? `Saved changes to ${saved.name}.` : `Added ${saved.name} to ${cityLabel(city)}.`);
    } catch (err) {
      setStatus(`Couldn't save: ${err.message}`, true);
      saveBtn.disabled = false;
    }
  });

  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  name.focus({ preventScroll: true });
}

function applySearch() {
  const q = searchInput.value.trim().toLowerCase();
  const byId = new Map(people.map((p) => [String(p.id), p]));
  let shown = 0;
  for (const li of list.querySelectorAll('.person:not(.editing)')) {
    li.hidden = !(li.dataset.name.includes(q) && matchesBlood(byId.get(li.dataset.id)));
    if (!li.hidden) shown++;
  }

  const where = cityLabel(city);
  const what = [
    q && `named “${searchInput.value.trim()}”`,
    bloodFilter && (compatToggle.checked ? `who can donate to ${bloodFilter}` : `with blood group ${bloodFilter}`),
  ].filter(Boolean).join(' ');

  if (!people.length) setStatus('');
  else if (!what) setStatus(`${people.length} people in ${where}`);
  else if (shown) setStatus(`${shown} of ${people.length} in ${where} ${what}`);
  else setStatus(`No one in ${where} ${what}. Try another city tab.`);
}

// Shared with family.js
window.Sumra = {
  api, el, formatDate, formatLoose, parseLooseDate, cityLabel, citySelect, setStatus, BLOOD_GROUPS,
  getCities: () => cities,
  reload: () => { loadList(); loadCities(); },
  ready: loadCities().then(() => loadList()),
};

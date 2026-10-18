// Receipts — rental property expense tracker.
// All data is stored on-device in IndexedDB. No server, no account.

// Libraries are bundled in vendor/ so the app works offline and never calls out to a CDN.
const vendor = path => new URL(`vendor/${path}`, location.href).href;
const TESSERACT_URL = vendor('tesseract/tesseract.min.js');
const JSPDF_URL = vendor('jspdf/jspdf.umd.min.js');
const AUTOTABLE_URL = vendor('jspdf/jspdf.plugin.autotable.min.js');

// When hosted as a claude.ai artifact, file saves go through the viewer's save prompt.
const inArtifact = typeof window.claude?.use === 'function';

const CATEGORIES = [
  { id: 'repair', label: 'Repair & Maintenance' },
  { id: 'improvement', label: 'Capital Improvement' },
  { id: 'appliance', label: 'Appliance & Equipment' },
  { id: 'supplies', label: 'Supplies' },
  { id: 'labor', label: 'Contractor & Labor' },
  { id: 'other', label: 'Other' },
];
const categoryLabel = id => (CATEGORIES.find(c => c.id === id) || CATEGORIES.at(-1)).label;

// ---------- Utilities ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = cents => currency.format((cents || 0) / 100);

function parseMoney(str) {
  const n = parseFloat(String(str ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => toDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const yearOf = s => Number(s.slice(0, 4));

const sumCents = list => list.reduce((t, e) => t + (e.amount || 0), 0);
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? word.slice(0, -1) + 'ies' : word + 's'}`;

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.5-2h7.4l1.5 2h2.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 8"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"/></svg>',
  house: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5"/></svg>',
};

// ---------- IndexedDB ----------

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('receipt-tracker', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('properties', { keyPath: 'id' });
      d.createObjectStore('entries', { keyPath: 'id' });
      d.createObjectStore('photos', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const r = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const idb = {
  all: name => run(name, 'readonly', s => s.getAll()),
  get: (name, key) => run(name, 'readonly', s => s.get(key)),
  put: (name, value) => run(name, 'readwrite', s => s.put(value)),
  del: (name, key) => run(name, 'readwrite', s => s.delete(key)),
};

// ---------- State ----------

const state = {
  properties: [],
  entries: [],
  tab: 'overview',
  year: new Date().getFullYear(),
  filterProperty: 'all',
  sheet: null,
};

function sortData() {
  state.properties.sort((a, b) => a.name.localeCompare(b.name));
  state.entries.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

async function load() {
  [state.properties, state.entries] = await Promise.all([idb.all('properties'), idb.all('entries')]);
  sortData();
}

const propertyById = id => state.properties.find(p => p.id === id);

function years() {
  const set = new Set(state.entries.map(e => yearOf(e.date)));
  set.add(new Date().getFullYear());
  set.add(state.year);
  return [...set].sort((a, b) => b - a);
}

const entriesFor = (year, propertyId = 'all') =>
  state.entries.filter(e => yearOf(e.date) === year && (propertyId === 'all' || e.propertyId === propertyId));

// ---------- Rendering ----------

function render() {
  const views = { overview: overviewView, entries: entriesView, properties: propertiesView };
  $('#view').innerHTML = views[state.tab]();
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
}

function yearPicker() {
  return `<div class="segmented-wrap"><div class="segmented" role="tablist">
    ${years().map(y => `<button role="tab" class="${y === state.year ? 'active' : ''}" data-action="year" data-year="${y}">${y}</button>`).join('')}
  </div></div>`;
}

function overviewView() {
  const list = entriesFor(state.year);
  const total = sumCents(list);
  const withReceipt = list.filter(e => e.hasPhoto).length;

  const byProperty = state.properties
    .map(p => ({ p, items: list.filter(e => e.propertyId === p.id) }))
    .map(x => ({ ...x, total: sumCents(x.items) }));

  const byCategory = CATEGORIES
    .map(c => ({ c, total: sumCents(list.filter(e => e.category === c.id)), count: list.filter(e => e.category === c.id).length }))
    .filter(x => x.count);

  return `
    <header class="header">
      <div><div class="eyebrow">Tax Year ${state.year}</div><h1>Overview</h1></div>
    </header>
    ${yearPicker()}

    <section class="hero">
      <div class="hero-label">Total expenses</div>
      <div class="hero-amount">${money(total)}</div>
      <div class="hero-sub">${plural(list.length, 'expense')} · ${withReceipt} with receipt</div>
    </section>

    <div class="actions">
      <button class="action" data-action="add-scan">
        <span class="glyph">${ICON.camera}</span>Scan Receipt
      </button>
      <button class="action" data-action="add-manual">
        <span class="glyph gray">${ICON.pencil}</span>Enter Manually
      </button>
    </div>

    <h2 class="section-title"><span>By Property</span></h2>
    ${state.properties.length ? `<ul class="list" style="--inset:16px">
      ${byProperty.map(({ p, items, total: t }) => `
        <li><button class="cell" data-action="show-property" data-id="${p.id}">
          <div class="cell-main">
            <div class="cell-title">${esc(p.name)}</div>
            <div class="cell-sub">${plural(items.length, 'expense')}</div>
          </div>
          <span class="cell-value strong">${money(t)}</span>${ICON.chev}
        </button></li>`).join('')}
    </ul>` : `<ul class="list"><li><button class="cell link" data-action="add-property">Add your first property</button></li></ul>`}

    ${byCategory.length ? `
      <h2 class="section-title"><span>By Type</span></h2>
      <ul class="list">
        ${byCategory.map(({ c, total: t, count }) => `
          <li><div class="cell">
            <div class="cell-main">
              <div style="display:flex;justify-content:space-between;gap:12px">
                <span class="cell-title">${c.label}</span>
                <span class="cell-value strong">${money(t)}</span>
              </div>
              <div class="cell-sub">${plural(count, 'expense')}</div>
              <div class="bar"><span style="width:${total > 0 ? Math.max(2, Math.round((t / total) * 100)) : 0}%"></span></div>
            </div>
          </div></li>`).join('')}
      </ul>` : ''}

    <h2 class="section-title"><span>Tax Records</span></h2>
    <ul class="list">
      <li><button class="cell link" data-action="share-report">Email ${state.year} Report (PDF)</button></li>
      <li><button class="cell link" data-action="export-csv">Export ${state.year} Spreadsheet (CSV)</button></li>
      <li><button class="cell link" data-action="backup">Back Up All Data</button></li>
      <li><button class="cell link" data-action="restore">Restore from Backup</button></li>
    </ul>
    <p class="section-foot">Data is stored only on this device. Back up periodically to keep a copy elsewhere.</p>
  `;
}

function entriesView() {
  const list = entriesFor(state.year, state.filterProperty);
  const groups = new Map();
  for (const e of list) {
    const key = e.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const filterLabel = state.filterProperty === 'all' ? 'All properties' : esc(propertyById(state.filterProperty)?.name);

  return `
    <header class="header">
      <div><div class="eyebrow">${state.year} · ${filterLabel}</div><h1>${money(sumCents(list))}</h1></div>
      <button class="icon-btn" data-action="add-menu" aria-label="Add expense">${ICON.plus}</button>
    </header>
    <div class="filters">
      <select class="pill-select" data-change="year" aria-label="Year">
        ${years().map(y => `<option value="${y}" ${y === state.year ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select class="pill-select" data-change="filter-property" aria-label="Property">
        <option value="all">All properties</option>
        ${state.properties.map(p => `<option value="${p.id}" ${p.id === state.filterProperty ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </div>

    ${list.length ? [...groups].map(([key, items]) => `
      <h2 class="section-title">
        <span>${toDate(key + '-01').toLocaleDateString('en-US', { month: 'long' })}</span>
        <span>${money(sumCents(items))}</span>
      </h2>
      <ul class="list" style="--inset:68px">
        ${items.map(entryRow).join('')}
      </ul>`).join('') : `
      <div class="empty">
        ${ICON.receipt}
        <h3>No Expenses</h3>
        <p>Scan a receipt or enter an expense manually to start tracking ${state.year}.</p>
        <button class="btn" data-action="add-menu">Add Expense</button>
      </div>`}
  `;
}

function entryRow(e) {
  const prop = propertyById(e.propertyId);
  const title = e.vendor || e.description || categoryLabel(e.category);
  const sub = [state.filterProperty === 'all' ? prop?.name : null, e.vendor ? e.description : null, fmtDate(e.date)].filter(Boolean).join(' · ');
  const thumb = e.thumb
    ? `<span class="thumb" style="background-image:url('${e.thumb}')"></span>`
    : `<span class="thumb">${ICON.pencil}</span>`;
  return `<li><button class="cell" data-action="open-entry" data-id="${e.id}">
    ${thumb}
    <div class="cell-main">
      <div class="cell-title">${esc(title)}</div>
      <div class="cell-sub">${esc(sub)}</div>
    </div>
    <span class="cell-value strong">${money(e.amount)}</span>${ICON.chev}
  </button></li>`;
}

function propertiesView() {
  return `
    <header class="header">
      <div><div class="eyebrow">${plural(state.properties.length, 'property')}</div><h1>Properties</h1></div>
      <button class="icon-btn" data-action="add-property" aria-label="Add property">${ICON.plus}</button>
    </header>
    ${state.properties.length ? `
      <ul class="list">
        ${state.properties.map(p => {
          const items = entriesFor(state.year, p.id);
          const all = state.entries.filter(e => e.propertyId === p.id);
          return `<li><button class="cell" data-action="edit-property" data-id="${p.id}">
            <div class="cell-main">
              <div class="cell-title">${esc(p.name)}</div>
              <div class="cell-sub">${esc(p.address || 'No address')}</div>
            </div>
            <div style="text-align:right">
              <div class="cell-value strong">${money(sumCents(items))}</div>
              <div class="cell-sub">${state.year} · ${money(sumCents(all))} all time</div>
            </div>${ICON.chev}
          </button></li>`;
        }).join('')}
      </ul>
      <p class="section-foot">Tap a property to edit its details.</p>` : `
      <div class="empty">
        ${ICON.house}
        <h3>No Properties</h3>
        <p>Add each rental property so expenses can be tracked separately.</p>
        <button class="btn" data-action="add-property">Add Property</button>
      </div>`}
  `;
}

// ---------- Sheets ----------

function openSheet(html) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-layer"><div class="sheet-backdrop" data-action="sheet-cancel"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => requestAnimationFrame(() => $('.sheet-layer', root)?.classList.add('open')));
}

function closeSheet() {
  const s = state.sheet;
  if (s?.photoUrl) URL.revokeObjectURL(s.photoUrl);
  if (s?.url) setTimeout(() => URL.revokeObjectURL(s.url), 60_000);
  state.sheet = null;
  document.body.style.overflow = '';
  const layer = $('#sheet-root .sheet-layer');
  if (!layer) return;
  layer.classList.remove('open');
  setTimeout(() => { if (!state.sheet) $('#sheet-root').innerHTML = ''; }, 400);
}

// Action sheet for adding an expense
function openAddMenu() {
  state.sheet = { kind: 'menu' };
  openSheet(`
    <div class="sheet-nav"><button data-action="sheet-cancel">Cancel</button><h2>Add Expense</h2><span></span></div>
    <div class="sheet-body">
      <ul class="list" style="--inset:60px">
        <li><button class="cell" data-action="add-scan"><span class="thumb" style="color:var(--tint)">${ICON.camera}</span><div class="cell-main"><div class="cell-title">Scan Receipt</div><div class="cell-sub">Take a photo with the camera</div></div>${ICON.chev}</button></li>
        <li><button class="cell" data-action="add-photo"><span class="thumb" style="color:var(--tint)">${ICON.photo}</span><div class="cell-main"><div class="cell-title">Choose Photo</div><div class="cell-sub">Use an existing image</div></div>${ICON.chev}</button></li>
        <li><button class="cell" data-action="add-manual"><span class="thumb">${ICON.pencil}</span><div class="cell-main"><div class="cell-title">Enter Manually</div><div class="cell-sub">For expenses without a receipt</div></div>${ICON.chev}</button></li>
      </ul>
    </div>`);
}

// --- Property sheet ---

function openPropertySheet(id, then) {
  const p = id ? propertyById(id) : null;
  state.sheet = { kind: 'property', then, draft: { id: p?.id || null, name: p?.name || '', address: p?.address || '', notes: p?.notes || '', createdAt: p?.createdAt } };
  const count = p ? state.entries.filter(e => e.propertyId === p.id).length : 0;
  openSheet(`
    <div class="sheet-nav">
      <button data-action="sheet-cancel">Cancel</button>
      <h2>${p ? 'Edit Property' : 'New Property'}</h2>
      <button class="primary" data-action="save-property" ${p ? '' : 'disabled'}>${p ? 'Done' : 'Add'}</button>
    </div>
    <div class="sheet-body">
      <ul class="list">
        <li><div class="form-row"><label for="p-name">Name</label><input id="p-name" name="name" placeholder="e.g. Elm Street Duplex" value="${esc(p?.name)}" autocomplete="off"></div></li>
        <li><div class="form-row"><label for="p-address">Address</label><input id="p-address" name="address" placeholder="Optional" value="${esc(p?.address)}" autocomplete="street-address"></div></li>
      </ul>
      <h2 class="section-title"><span>Notes</span></h2>
      <ul class="list"><li><textarea class="notes" name="notes" placeholder="Purchase date, unit count, etc.">${esc(p?.notes)}</textarea></li></ul>
      ${p ? `
        <h2 class="section-title"><span>&nbsp;</span></h2>
        <ul class="list"><li><button class="cell destructive" data-action="delete-property">Delete Property</button></li></ul>
        <p class="section-foot">${count ? `Deleting this property also deletes its ${plural(count, 'expense')}.` : ''}</p>` : ''}
    </div>`);
  if (!p) setTimeout(() => $('#p-name')?.focus(), 350);
}

async function saveProperty() {
  const s = state.sheet;
  const d = s.draft;
  const name = d.name.trim();
  if (!name) return;
  const rec = { id: d.id || uid(), name, address: d.address.trim(), notes: d.notes.trim(), createdAt: d.createdAt || Date.now(), updatedAt: Date.now() };
  await idb.put('properties', rec);
  const i = state.properties.findIndex(p => p.id === rec.id);
  if (i >= 0) state.properties[i] = rec; else state.properties.push(rec);
  sortData();
  closeSheet();
  render();
  toast(d.id ? 'Property updated' : 'Property added');
  if (s.then) setTimeout(() => s.then(rec), 420);
}

async function deleteProperty() {
  const id = state.sheet.draft.id;
  const p = propertyById(id);
  const items = state.entries.filter(e => e.propertyId === id);
  const msg = items.length
    ? `Delete “${p.name}” and its ${plural(items.length, 'expense')}? This cannot be undone.`
    : `Delete “${p.name}”?`;
  if (!(await ask(msg, 'Delete'))) return;
  for (const e of items) {
    await idb.del('entries', e.id);
    await idb.del('photos', e.id);
  }
  await idb.del('properties', id);
  state.entries = state.entries.filter(e => e.propertyId !== id);
  state.properties = state.properties.filter(x => x.id !== id);
  if (state.filterProperty === id) state.filterProperty = 'all';
  closeSheet();
  render();
  toast('Property deleted');
}

// --- Expense sheet ---

function defaultPropertyId() {
  if (state.filterProperty !== 'all' && propertyById(state.filterProperty)) return state.filterProperty;
  let last = null;
  try { last = localStorage.getItem('lastPropertyId'); } catch {}
  return propertyById(last) ? last : state.properties[0]?.id;
}

function startEntry(source) {
  if (!state.properties.length) {
    toast('Add a property first');
    openPropertySheet(null, () => startEntry(null));
    return;
  }
  const date = state.year === new Date().getFullYear() ? today() : `${state.year}-12-31`;
  state.sheet = {
    kind: 'entry',
    draft: { id: null, propertyId: defaultPropertyId(), date, vendor: '', description: '', amount: '', category: 'repair', notes: '', thumb: null },
    photo: null, photoUrl: null, photoChanged: false, photoLoading: false, ocr: 'idle', touched: new Set(),
  };
  renderEntrySheet();
  // Must run inside the user's tap so the browser allows the picker to open.
  if (source) $(source === 'camera' ? '#camera-input' : '#library-input').click();
}

async function openEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  state.sheet = {
    kind: 'entry',
    draft: { ...e, amount: (e.amount / 100).toFixed(2) },
    photo: null, photoUrl: null, photoChanged: false, photoLoading: !!e.hasPhoto, ocr: 'idle',
    touched: new Set(['vendor', 'description', 'amount', 'date', 'notes', 'category', 'propertyId']),
  };
  const s = state.sheet;
  renderEntrySheet();
  if (e.hasPhoto) {
    const rec = await idb.get('photos', id);
    if (state.sheet !== s) return;
    s.photoLoading = false;
    if (rec?.blob) { s.photo = rec.blob; s.photoUrl = URL.createObjectURL(rec.blob); }
    updatePhotoArea();
  }
}

function renderEntrySheet() {
  const s = state.sheet;
  const d = s.draft;
  openSheet(`
    <div class="sheet-nav">
      <button data-action="sheet-cancel">Cancel</button>
      <h2>${d.id ? 'Expense' : 'New Expense'}</h2>
      <button class="primary" data-action="save-entry">${d.id ? 'Done' : 'Save'}</button>
    </div>
    <div class="sheet-body">
      <div id="photo-area">${photoAreaHtml(s)}</div>

      <label class="amount-field"><span>$</span><input name="amount" inputmode="decimal" placeholder="0.00" value="${esc(d.amount)}" autocomplete="off" aria-label="Amount"></label>

      <ul class="list">
        <li><div class="form-row"><label for="e-vendor">Vendor</label><input id="e-vendor" name="vendor" placeholder="Store or contractor" value="${esc(d.vendor)}" autocomplete="off"></div></li>
        <li><div class="form-row"><label for="e-desc">Description</label><input id="e-desc" name="description" placeholder="What was done" value="${esc(d.description)}" autocomplete="off"></div></li>
        <li><div class="form-row"><label for="e-date">Date</label><input id="e-date" type="date" name="date" value="${esc(d.date)}" required></div></li>
      </ul>

      <h2 class="section-title"><span>Classification</span></h2>
      <ul class="list">
        <li><div class="form-row"><label for="e-prop">Property</label>
          <select id="e-prop" name="propertyId">
            ${state.properties.map(p => `<option value="${p.id}" ${p.id === d.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></div></li>
        <li><div class="form-row"><label for="e-cat">Type</label>
          <select id="e-cat" name="category">
            ${CATEGORIES.map(c => `<option value="${c.id}" ${c.id === d.category ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select></div></li>
      </ul>

      <h2 class="section-title"><span>Notes</span></h2>
      <ul class="list"><li><textarea class="notes" name="notes" placeholder="Unit, room, warranty, payment method…">${esc(d.notes)}</textarea></li></ul>

      ${d.id ? `
        <h2 class="section-title"><span>&nbsp;</span></h2>
        <ul class="list"><li><button class="cell destructive" data-action="delete-entry">Delete Expense</button></li></ul>` : ''}
    </div>`);
}

function photoAreaHtml(s) {
  if (s.photoLoading) return `<div class="photo"><div class="photo-loading">Loading receipt…</div></div>`;
  if (!s.photoUrl) {
    return `<div class="photo-empty">
      <button class="photo-tile" data-action="photo-camera">${ICON.camera}Scan Receipt</button>
      <button class="photo-tile" data-action="photo-library">${ICON.photo}Choose Photo</button>
    </div>`;
  }
  const status = {
    idle: '',
    running: '<span class="spinner"></span>Reading receipt…',
    done: 'Details filled from receipt',
    none: 'Couldn’t read details — enter them below',
    error: 'Receipt saved — text recognition unavailable',
  }[s.ocr];
  return `<div class="photo">
    <img src="${s.photoUrl}" alt="Receipt photo" data-action="photo-view">
    <div class="photo-bar">
      <span class="status">${status}</span>
      <button data-action="photo-camera">Retake</button>
      <button class="destructive" data-action="photo-remove">Remove</button>
    </div>
  </div>`;
}

function updatePhotoArea() {
  const el = $('#photo-area');
  if (el && state.sheet?.kind === 'entry') el.innerHTML = photoAreaHtml(state.sheet);
}

function syncInputs() {
  const d = state.sheet?.draft;
  if (!d) return;
  $$('#sheet-root [name]').forEach(el => {
    if (el !== document.activeElement && d[el.name] !== undefined) el.value = d[el.name];
  });
}

async function onPhotoChosen(file) {
  const s = state.sheet;
  if (!file || s?.kind !== 'entry') return;
  s.photoLoading = true;
  updatePhotoArea();
  let blob;
  try { blob = await resizeImage(file, 2000, 0.85); } catch { blob = file; }
  let thumb = null;
  try { thumb = await blobToDataUrl(await resizeImage(blob, 160, 0.7)); } catch {}
  if (state.sheet !== s) return;
  if (s.photoUrl) URL.revokeObjectURL(s.photoUrl);
  Object.assign(s, { photo: blob, photoUrl: URL.createObjectURL(blob), photoChanged: true, photoLoading: false });
  s.draft.thumb = thumb;
  updatePhotoArea();
  readReceipt(blob);
}

function removePhoto() {
  const s = state.sheet;
  if (s.photoUrl) URL.revokeObjectURL(s.photoUrl);
  Object.assign(s, { photo: null, photoUrl: null, photoChanged: true, ocr: 'idle' });
  s.draft.thumb = null;
  updatePhotoArea();
}

async function saveEntry() {
  const s = state.sheet;
  const d = s.draft;
  const amount = parseMoney(d.amount);
  if (amount === null || amount === 0) { toast('Enter an amount'); $('[name=amount]')?.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) { toast('Enter a date'); return; }
  if (!propertyById(d.propertyId)) { toast('Choose a property'); return; }

  const rec = {
    id: d.id || uid(),
    propertyId: d.propertyId,
    date: d.date,
    vendor: (d.vendor || '').trim(),
    description: (d.description || '').trim(),
    amount,
    category: d.category,
    notes: (d.notes || '').trim(),
    hasPhoto: !!s.photo,
    thumb: s.photo ? d.thumb : null,
    createdAt: d.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  if (s.photoChanged) {
    if (s.photo) await idb.put('photos', { id: rec.id, blob: s.photo });
    else await idb.del('photos', rec.id);
  }
  await idb.put('entries', rec);
  try { localStorage.setItem('lastPropertyId', rec.propertyId); } catch {}

  const i = state.entries.findIndex(e => e.id === rec.id);
  if (i >= 0) state.entries[i] = rec; else state.entries.push(rec);
  sortData();
  state.year = yearOf(rec.date);
  closeSheet();
  render();
  toast(d.id ? 'Expense updated' : `Saved · ${state.year} total ${money(sumCents(entriesFor(state.year)))}`);
}

async function deleteEntry() {
  const id = state.sheet.draft.id;
  if (!(await ask('Delete this expense? This cannot be undone.', 'Delete'))) return;
  await idb.del('entries', id);
  await idb.del('photos', id);
  state.entries = state.entries.filter(e => e.id !== id);
  closeSheet();
  render();
  toast('Expense deleted');
}

function openViewer(url) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img src="${url}" alt="Receipt"><button>Done</button>`;
  v.addEventListener('click', () => v.remove());
  document.body.appendChild(v);
}

// ---------- Images ----------

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = e => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function resizeImage(blob, maxSide, quality) {
  const img = await loadImage(blob);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality));
}

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// ---------- Receipt text recognition ----------

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); s.remove(); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

async function readReceipt(blob) {
  const s = state.sheet;
  s.ocr = 'running';
  updatePhotoArea();
  try {
    await loadScript(TESSERACT_URL);
    const { Tesseract } = window;
    const { data } = await Tesseract.recognize(blob, 'eng', {
      workerPath: vendor('tesseract/worker.min.js'),
      corePath: vendor('tesseract'),
      langPath: vendor('tesseract'),
    });
    if (state.sheet !== s) return;
    const found = parseReceipt(data.text || '');
    let filled = 0;
    const fill = (key, value) => {
      if (value == null || value === '' || s.touched.has(key) && s.draft[key]) return;
      s.draft[key] = value;
      filled++;
    };
    if (found.amount != null) fill('amount', (found.amount / 100).toFixed(2));
    fill('vendor', found.vendor);
    if (found.date && !s.touched.has('date')) { s.draft.date = found.date; filled++; }
    s.ocr = filled ? 'done' : 'none';
  } catch {
    if (state.sheet !== s) return;
    s.ocr = 'error';
  }
  updatePhotoArea();
  syncInputs();
}

export function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const amountRe = /(?:\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s?[.,]\s?(\d{2})(?!\d)/g;
  const amountsIn = line => [...line.matchAll(amountRe)].map(m => Number(m[1].replace(/,/g, '')) * 100 + Number(m[2]));
  const excluded = /sub\s*-?\s*total|total\s*(savings|saved|discount|items?|qty|tax)|you\s*saved|change|cash\s*back|tender/i;

  let amount = null;
  const priorities = [
    /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*amount|order\s*total)\b/i,
    /\btotal\b/i,
    /\b(amount|balance|visa|mastercard|amex|debit|credit|charged)\b/i,
  ];
  outer: for (const re of priorities) {
    for (const line of lines) {
      if (!re.test(line) || excluded.test(line)) continue;
      const found = amountsIn(line);
      if (found.length) { amount = found.at(-1); break outer; }
    }
  }
  if (amount == null) {
    const all = lines.flatMap(amountsIn).filter(n => n > 0 && n < 10_000_000);
    if (all.length) amount = Math.max(...all);
  }

  const thisYear = new Date().getFullYear();
  const validDate = (y, m, d) => {
    if (y < 100) y += 2000;
    if (y < 2000 || y > thisYear + 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    return dt.getMonth() === m - 1 ? isoDate(dt) : null;
  };
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let date = null;
  for (const line of lines) {
    let m;
    if ((m = line.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/))) date = validDate(+m[1], +m[2], +m[3]);
    if (!date && (m = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/))) date = validDate(+m[3], +m[1], +m[2]);
    if (!date && (m = line.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i))) {
      date = validDate(+m[3], months.indexOf(m[1].toLowerCase()) + 1, +m[2]);
    }
    if (date) break;
  }

  let vendor = null;
  for (const line of lines.slice(0, 6)) {
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters < 3 || letters / line.length < 0.5) continue;
    if (/receipt|invoice|welcome|thank|store\s*#|^\W*www\.|^\d/i.test(line)) continue;
    vendor = line.replace(/[^\w&'.\- ]/g, '').replace(/\s+/g, ' ').trim();
    if (vendor === vendor.toUpperCase()) vendor = vendor.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    if (vendor.length > 40) vendor = vendor.slice(0, 40).trim();
    break;
  }

  return { amount, date, vendor };
}

// ---------- Export / backup ----------

async function download(filename, blob) {
  if (inArtifact) {
    const downloads = await window.claude.use('downloads');
    if (!downloads) { toast('Saving files isn’t available here'); return; }
    try { await downloads.save({ filename, data: blob }); }
    catch (err) { if (err?.code !== 'declined') toast('Couldn’t save the file'); }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function csvBlob(year) {
  const list = entriesFor(year).slice().sort((a, b) => {
    const pa = propertyById(a.propertyId)?.name || '', pb = propertyById(b.propertyId)?.name || '';
    return pa.localeCompare(pb) || a.date.localeCompare(b.date);
  });
  if (!list.length) return null;
  const rows = [['Date', 'Property', 'Address', 'Vendor', 'Description', 'Type', 'Amount', 'Receipt', 'Notes']];
  for (const e of list) {
    const p = propertyById(e.propertyId);
    rows.push([e.date, p?.name, p?.address, e.vendor, e.description, categoryLabel(e.category), (e.amount / 100).toFixed(2), e.hasPhoto ? 'Yes' : 'No', e.notes]);
  }
  rows.push([]);
  for (const p of state.properties) {
    const items = list.filter(e => e.propertyId === p.id);
    if (items.length) rows.push(['', `${p.name} total`, '', '', '', '', (sumCents(items) / 100).toFixed(2), '', '']);
  }
  rows.push(['', `${year} total`, '', '', '', '', (sumCents(list) / 100).toFixed(2), '', '']);
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
}

function exportCsv() {
  const blob = csvBlob(state.year);
  if (!blob) { toast(`No expenses in ${state.year}`); return; }
  download(`rental-expenses-${state.year}.csv`, blob);
}

// Builds a letter-size PDF: summary, per-property detail, then one receipt image per page.
async function buildPdf(year) {
  await loadScript(JSPDF_URL);
  await loadScript(AUTOTABLE_URL);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;

  const list = entriesFor(year).slice().sort((a, b) => a.date.localeCompare(b.date));
  const props = state.properties.filter(p => list.some(e => e.propertyId === p.id));

  const table = (startY, head, body, foot, amountCol) => {
    doc.autoTable({
      startY, head: [head], body, foot: foot ? [foot] : undefined, showFoot: 'lastPage',
      theme: 'striped', margin: { left: M, right: M, bottom: M + 12 },
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: [28, 28, 30], overflow: 'linebreak' },
      headStyles: { fillColor: [255, 255, 255], textColor: [110, 110, 115], fontStyle: 'bold', lineWidth: { bottom: 0.75 }, lineColor: [200, 200, 205] },
      footStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', lineWidth: { top: 0.75 }, lineColor: [0, 0, 0] },
      alternateRowStyles: { fillColor: [246, 246, 248] },
      columnStyles: { [amountCol]: { halign: 'right', cellWidth: 72 } },
      didParseCell: d => { if (d.column.index === amountCol) d.cell.styles.halign = 'right'; },
    });
    return doc.lastAutoTable.finalY;
  };
  const heading = (text, y, size = 13) => {
    if (y > H - 120) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(0, 0, 0);
    doc.text(text, M, y);
    return y + 10;
  };

  // Title and summary
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(`Rental Property Expenses - ${year}`, M, M + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110, 110, 115);
  doc.text(`${plural(list.length, 'expense')} across ${plural(props.length, 'property')} · Total ${money(sumCents(list))}`, M, M + 26);

  let y = heading('Summary by Property', M + 60);
  y = table(y, ['Property', 'Address', 'Expenses', 'Total'],
    props.map(p => { const items = list.filter(e => e.propertyId === p.id); return [p.name, p.address || '', String(items.length), money(sumCents(items))]; }),
    ['Total', '', String(list.length), money(sumCents(list))], 3);

  y = heading('Summary by Type', y + 28);
  y = table(y, ['Type', 'Expenses', 'Total'],
    CATEGORIES.map(c => ({ c, items: list.filter(e => e.category === c.id) })).filter(x => x.items.length)
      .map(({ c, items }) => [c.label, String(items.length), money(sumCents(items))]),
    ['Total', String(list.length), money(sumCents(list))], 2);

  // Detail per property
  for (const p of props) {
    const items = list.filter(e => e.propertyId === p.id);
    y = heading(p.address ? `${p.name} - ${p.address}` : p.name, y + 32);
    y = table(y, ['Date', 'Vendor', 'Description', 'Type', 'Receipt', 'Amount'],
      items.map(e => [fmtDate(e.date), e.vendor, e.notes ? `${e.description}\n${e.notes}` : e.description, categoryLabel(e.category), e.hasPhoto ? 'Attached' : 'None', money(e.amount)]),
      ['Total', '', '', '', '', money(sumCents(items))], 5);
  }

  // Receipt images, one per page
  for (const e of list.filter(x => x.hasPhoto)) {
    const rec = await idb.get('photos', e.id);
    if (!rec?.blob) continue;
    let img, dataUrl;
    try {
      const small = await resizeImage(rec.blob, 1400, 0.72);
      dataUrl = await blobToDataUrl(small);
      img = await loadImage(small);
    } catch { continue; }
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.text(`${fmtDate(e.date)} · ${propertyById(e.propertyId)?.name || ''} · ${money(e.amount)}`, M, M);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110, 110, 115);
    doc.text([e.vendor, e.description].filter(Boolean).join(' - ') || categoryLabel(e.category), M, M + 14);
    const top = M + 28, maxW = W - 2 * M, maxH = H - top - M - 12;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    doc.addImage(dataUrl, 'JPEG', M + (maxW - w) / 2, top, w, h);
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  const generated = `Generated ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}`;
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 145);
    doc.text(generated, M, H - 24);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 24, { align: 'right' });
  }

  return { blob: doc.output('blob'), pages };
}

async function openReport() {
  const year = state.year;
  if (!entriesFor(year).length) { toast(`No expenses in ${year}`); return; }
  toast('Preparing report…');
  let pdf;
  try { pdf = await buildPdf(year); } catch { toast('Couldn’t create the report. Try again.'); return; }
  const name = `rental-expenses-${year}`;
  const file = new File([pdf.blob], `${name}.pdf`, { type: 'application/pdf' });
  const csv = new File([csvBlob(year)], `${name}.csv`, { type: 'text/csv' });
  const canShare = !inArtifact && !!navigator.canShare?.({ files: [file] });
  const size = file.size > 1e6 ? `${(file.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1e3))} KB`;

  $('#toast').classList.remove('show');
  state.sheet = { kind: 'report', year, file, csv, url: URL.createObjectURL(file) };
  // Sharing needs a fresh tap, so the PDF is prepared first and shared from this sheet.
  openSheet(`
    <div class="sheet-nav"><button data-action="sheet-cancel">Done</button><h2>${year} Report</h2><span></span></div>
    <div class="sheet-body">
      <div class="report-card">
        <div class="report-icon">PDF</div>
        <div class="cell-title">${name}.pdf</div>
        <div class="cell-sub">${plural(pdf.pages, 'page')} · ${size}</div>
      </div>
      <ul class="list">
        ${canShare ? `
          <li><button class="cell link" data-action="report-share">Email or Share PDF</button></li>
          <li><button class="cell link" data-action="report-share-all">Email PDF + Spreadsheet</button></li>` : ''}
        <li><button class="cell link" data-action="report-save">${canShare ? 'Save PDF' : 'Save or Email PDF'}</button></li>
        ${canShare ? '' : '<li><button class="cell link" data-action="report-save-csv">Save Spreadsheet (CSV)</button></li>'}
        ${inArtifact ? '' : '<li><button class="cell link" data-action="report-preview">Preview</button></li>'}
      </ul>
      <p class="section-foot">${canShare
        ? 'Choose Mail in the share sheet to send the report as an attachment. The spreadsheet option attaches a CSV that opens in Excel or Numbers.'
        : inArtifact
          ? 'In the Claude app on iPhone, saving opens the share sheet. Choose Mail to send the report as an attachment.'
          : 'This browser can’t share files directly. Save the PDF, then attach it to an email.'}</p>
    </div>`);
}

async function shareReport(files) {
  const s = state.sheet;
  try {
    await navigator.share({ files, title: `Rental Property Expenses ${s.year}`, text: `Rental property expense report for ${s.year}.` });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Sharing failed — try Save PDF');
  }
}

async function backup() {
  toast('Preparing backup…');
  const photos = await idb.all('photos');
  const data = {
    app: 'receipt-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    properties: state.properties,
    entries: state.entries,
    photos: await Promise.all(photos.map(async p => ({ id: p.id, dataUrl: await blobToDataUrl(p.blob) }))),
  };
  download(`receipts-backup-${today()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Not a valid backup file'); return; }
  if (data?.app !== 'receipt-tracker' || !Array.isArray(data.properties) || !Array.isArray(data.entries)) {
    toast('Not a valid backup file');
    return;
  }
  if (!(await ask(`Restore ${plural(data.properties.length, 'property')} and ${plural(data.entries.length, 'expense')}? Matching records on this device will be replaced.`, 'Restore', false))) return;
  for (const p of data.properties) await idb.put('properties', p);
  for (const e of data.entries) await idb.put('entries', e);
  for (const ph of data.photos || []) {
    const blob = await (await fetch(ph.dataUrl)).blob();
    await idb.put('photos', { id: ph.id, blob });
  }
  await load();
  render();
  toast('Backup restored');
}

// ---------- Alert ----------

// In-page replacement for confirm(), which some hosts (such as embedded frames) suppress.
function ask(message, action, destructive = true) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'alert-layer';
    root.innerHTML = `<div class="alert" role="alertdialog" aria-modal="true">
      <p>${esc(message)}</p>
      <div class="alert-buttons">
        <button data-answer="no">Cancel</button>
        <button data-answer="yes" class="${destructive ? 'destructive' : 'primary'}">${esc(action)}</button>
      </div></div>`;
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-answer]');
      if (!b) return;
      e.stopPropagation();
      root.remove();
      resolve(b.dataset.answer === 'yes');
    });
    document.body.appendChild(root);
    $('[data-answer=no]', root).focus();
  });
}

// ---------- Toast ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- Events ----------

const actions = {
  'tab': el => { state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  'year': el => { state.year = Number(el.dataset.year); render(); },
  'show-property': el => { state.filterProperty = el.dataset.id; state.tab = 'entries'; render(); window.scrollTo(0, 0); },
  'add-menu': () => openAddMenu(),
  'add-scan': () => startEntry('camera'),
  'add-photo': () => startEntry('library'),
  'add-manual': () => startEntry(null),
  'open-entry': el => openEntry(el.dataset.id),
  'add-property': () => openPropertySheet(null),
  'edit-property': el => openPropertySheet(el.dataset.id),
  'save-property': () => saveProperty(),
  'delete-property': () => deleteProperty(),
  'save-entry': () => saveEntry(),
  'delete-entry': () => deleteEntry(),
  'sheet-cancel': () => closeSheet(),
  'photo-camera': () => $('#camera-input').click(),
  'photo-library': () => $('#library-input').click(),
  'photo-remove': () => removePhoto(),
  'photo-view': () => state.sheet?.photoUrl && openViewer(state.sheet.photoUrl),
  'export-csv': () => exportCsv(),
  'share-report': () => openReport(),
  'report-share': () => shareReport([state.sheet.file]),
  'report-share-all': () => shareReport([state.sheet.file, state.sheet.csv]),
  'report-save': () => download(state.sheet.file.name, state.sheet.file),
  'report-save-csv': () => download(state.sheet.csv.name, state.sheet.csv),
  'report-preview': () => { if (!window.open(state.sheet.url, '_blank')) toast('Preview isn’t available here. Save the PDF instead.'); },
  'backup': () => backup(),
  'restore': () => $('#restore-input').click(),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el, e);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.change === 'year') { state.year = Number(el.value); render(); }
  if (el.dataset.change === 'filter-property') { state.filterProperty = el.value; render(); }
});

// Bind sheet form fields to the draft
const onField = e => {
  const el = e.target;
  const s = state.sheet;
  if (!s?.draft || !el.name || !el.closest('#sheet-root')) return;
  s.draft[el.name] = el.value;
  s.touched?.add(el.name);
  if (s.kind === 'property') $('[data-action=save-property]').disabled = !s.draft.name.trim();
};
document.addEventListener('input', onField);
document.addEventListener('change', onField);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.sheet) closeSheet();
  if (e.key === 'Enter' && e.target.matches('#sheet-root input')) {
    e.preventDefault();
    state.sheet?.kind === 'property' ? saveProperty() : state.sheet?.kind === 'entry' && saveEntry();
  }
});

for (const id of ['#camera-input', '#library-input']) {
  $(id).addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    onPhotoChosen(file);
  });
}

$('#restore-input').addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) restore(file);
});

// ---------- Start ----------

(async function init() {
  try { await navigator.storage?.persist?.(); } catch {}
  await load();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

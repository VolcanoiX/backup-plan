'use strict';

/* =====================================================================
   План резервного копирования — клиентская часть (без фреймворков)
   Редактирование: форма раскрывается прямо под выбранной строкой (ED).
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru', { numeric: true });
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};
const newCopyId = () => 'cp_' + Array.from(crypto.getRandomValues(new Uint8Array(5)),
  (b) => b.toString(16).padStart(2, '0')).join('');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* хранилище недоступно */ } },
};

const THEMES = { system: 'Системная', light: 'Светлая', dark: 'Тёмная' };

const state = {
  meta: null,
  dicts: null,
  schema: null,
  data: null,
  idx: null,
  search: '',
  flash: null,
  prevHash: '',
  theme: THEMES[ls.get('bp.theme')] ? ls.get('bp.theme') : 'system',
};

/* ---------------------------------------------------------------- API */
async function api(method, url, payload) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Сервер ответил ошибкой ${res.status}. Повторите попытку.`);
    err.payload = json;
    throw err;
  }
  if (json.data) { state.data = json.data; reindex(); }
  return json;
}

function reindex() {
  const idx = { org: new Map(), dev: new Map(), set: new Map(), st: new Map() };
  for (const st of state.data.storages) { st.org_ids ||= []; idx.st.set(st.id, st); }
  for (const org of state.data.organizations) {
    org.devices ||= [];
    idx.org.set(org.id, org);
    for (const dev of org.devices) {
      dev.sets ||= [];
      idx.dev.set(dev.id, { org, dev });
      for (const set of dev.sets) {
        set.copies ||= [];
        idx.set.set(set.id, { org, dev, set });
      }
    }
  }
  state.idx = idx;
}

/* ------------------------------------------------------------ helpers */
const label = (dict, key) => (key && state.meta[dict][key]) || key || '';
const dictItem = (name, id) => state.dicts[name]?.find((i) => i.id === id);
const kindShort = (id) => { const it = dictItem('device_kinds', id); return it ? it.short || it.label : id || ''; };

/* справочники: полные списки + карты «код → название» для подписей и селектов */
function applyDicts(res) {
  state.schema = res.schema;
  state.dicts = res.dicts;
  state.meta = { storage_scopes: res.storage_scopes, copy_stages: res.copy_stages };
  for (const [name, sc] of Object.entries(res.schema)) {
    if (sc.kind === 'choice') state.meta[name] = Object.fromEntries(res.dicts[name].map((i) => [i.id, i.label]));
  }
  $('#datalists').innerHTML = Object.entries(res.schema).filter(([, sc]) => sc.kind === 'list')
    .map(([name]) => `<datalist id="dl-${name}">${res.dicts[name].map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`)
    .join('');
}
const orgStorages = (orgId) => state.data.storages.filter((s) => s.org_ids.includes(orgId)).sort(byName);
const orgSets = (org) => org.devices.flatMap((d) => d.sets);
const scopeOf = (st) => (st?.scope === 'remote' ? 'remote' : 'local');
const SCOPE_TEXT = { local: 'локальное', remote: 'удалённое' };
/* метка размещения: локальное — здание (офис), удалённое — облако (вне офиса) */
const ICON = {
  local: '<svg class="ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 14V6.5L8 2.5l5.5 4V14z"/><path d="M6.5 14v-3.5h3V14"/></svg>',
  remote: '<svg class="ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5h7.25a2.75 2.75 0 0 0 .3-5.48A4 4 0 0 0 4.3 7.6 2.5 2.5 0 0 0 4.5 12.5z"/></svg>',
};

/* ------------------------------------------------------------- значки
   Набор для типов устройств, наборов и хранилищ. В справочнике у значения
   хранится имя значка (поле icon); без него берётся стандартный по коду.   */
const DOT = 'stroke-width="2.6"';
const ICONS = {
  server: ['Сервер', `<rect x="3.5" y="4" width="17" height="6.5" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5"/><path ${DOT} d="M7 7.25h.01M7 16.75h.01"/>`],
  vm: ['Виртуальная машина', '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'],
  pc: ['Компьютер', '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>'],
  laptop: ['Ноутбук', '<rect x="5" y="5" width="14" height="10" rx="1.2"/><path d="M2.5 19h19l-2-4h-15z"/>'],
  mobile: ['Телефон, планшет', '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>'],
  nas: ['NAS', `<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7h7M8.5 10.5h7"/><path ${DOT} d="M12 16.5h.01"/>`],
  hdd: ['Диск', `<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 13h18"/><path ${DOT} d="M16.5 15.5h.01M13.5 15.5h.01"/>`],
  usb: ['USB-диск', `<rect x="7" y="9" width="10" height="12" rx="1.5"/><path d="M9 9V3.5h6V9"/><path ${DOT} d="M10.8 6h.01M13.2 6h.01"/>`],
  cpu: ['Процессор', '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>'],
  router: ['Сетевое устройство', `<rect x="3" y="13" width="18" height="7" rx="2"/><path ${DOT} d="M7 16.5h.01M10 16.5h.01"/><path d="M16.5 13V9.5M13.5 7a4.2 4.2 0 0 1 6 0M11.5 4.8a7 7 0 0 1 10 0"/>`],
  folder: ['Папка', '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z"/>'],
  share: ['Общая папка', '<path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h4l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 19 14H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M12 14v3.5M3.5 19.5h6M14.5 19.5h6"/><rect x="9.5" y="17.5" width="5" height="4" rx="1"/>'],
  files: ['Файлы', '<path d="M9 3.5h6.5l4 4V16a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 16V5A1.5 1.5 0 0 1 9 3.5z"/><path d="M15.5 3.5v4h4"/><path d="M4.5 7.5V19A1.5 1.5 0 0 0 6 20.5h9"/>'],
  doc: ['Документ', '<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/>'],
  database: ['База данных', '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V6"/><path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8"/>'],
  calc: ['Учётная база (1С)', `<rect x="5" y="3" width="14" height="18" rx="2"/><rect x="8" y="6" width="8" height="3.5" rx=".6"/><path ${DOT} d="M8.6 13h.01M12 13h.01M15.4 13h.01M8.6 16.6h.01M12 16.6h.01M15.4 16.6h.01"/>`],
  disc: ['Образ диска', '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 6.5a5.5 5.5 0 0 1 5.5 5.5"/>'],
  layers: ['Снимки, версии', '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16 12 20.5l8.5-4.5"/>'],
  archive: ['Архив', '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M4.5 8.5V18A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4"/>'],
  mail: ['Почта', '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>'],
  camera: ['Видеонаблюдение', '<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="m15.5 10.5 5-3v9l-5-3"/>'],
  code: ['Исходный код', '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>'],
  terminal: ['Консоль, скрипт', '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>'],
  users: ['Пользователи', '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.7c1.8.7 3 2.4 3.4 4.8"/>'],
  key: ['Ключи, сертификаты', '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5 19 9M14 9l2 2"/>'],
  shield: ['Безопасность', '<path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z"/>'],
  cloud: ['Облако', '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.6a4.5 4.5 0 0 0 0 8.9z"/>'],
  'cloud-up': ['Облачный диск', '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.6a4.5 4.5 0 0 0 0 8.9z"/><path d="M12 16.2v-4.6M9.9 13.6l2.1-2.1 2.1 2.1"/>'],
  bucket: ['Бакет S3', '<ellipse cx="12" cy="6.5" rx="8" ry="2.5"/><path d="M4 6.5 5.8 18.6c.15 1.1 2.9 1.9 6.2 1.9s6.05-.8 6.2-1.9L20 6.5"/>'],
  transfer: ['Передача (FTP)', '<path d="M4 8.5h15l-3.5-3.5M20 15.5H5l3.5 3.5"/>'],
  tape: ['Лента', '<rect x="3" y="5.5" width="18" height="13" rx="2"/><circle cx="8.5" cy="11.5" r="2.2"/><circle cx="15.5" cy="11.5" r="2.2"/><path d="M8.5 13.7h7M7 18.5l1.4-2.3h7.2l1.4 2.3"/>'],
  building: ['Здание, офис', '<path d="M4.5 20.5V5A1.5 1.5 0 0 1 6 3.5h8A1.5 1.5 0 0 1 15.5 5v15.5M15.5 9.5H18a1.5 1.5 0 0 1 1.5 1.5v9.5M3 20.5h18"/><path d="M8 7.5h1M11 7.5h1M8 11h1M11 11h1M8 14.5h1M11 14.5h1"/>'],
  globe: ['Интернет', '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5z"/>'],
  other: ['Другое', `<circle cx="12" cy="12" r="8.5"/><path ${DOT} d="M8 12h.01M12 12h.01M16 12h.01"/>`],
};
function icon(name, size = 16, cls = '') {
  const it = ICONS[name] || ICONS.other;
  return `<svg class="ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"`
    + ` stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${it[1]}</svg>`;
}
/* стандартные значки по коду значения; «_» — для значений, добавленных пользователем */
const DEFAULT_ICONS = {
  device_kinds: { physical: 'server', vm: 'vm', workstation: 'pc', nas: 'nas', other: 'other', _: 'server' },
  set_types: { folder: 'folder', files: 'files', db1c: 'calc', db_sql: 'database', share: 'share', image: 'disc', vm: 'vm', other: 'other', _: 'doc' },
  storage_types: { nas: 'nas', smb: 'share', disk_local: 'hdd', disk_usb: 'usb', s3: 'bucket', yadisk: 'cloud-up',
    cloud: 'cloud', ftp: 'transfer', server: 'server', tape: 'tape', other: 'other', _: 'archive' },
};
const defaultIcon = (dict, id) => DEFAULT_ICONS[dict]?.[id] || DEFAULT_ICONS[dict]?._ || 'other';
function typeIcon(dict, id) {
  const it = dictItem(dict, id);
  return it?.icon && ICONS[it.icon] ? it.icon : defaultIcon(dict, id);
}
const stIcon = (st) => (st.type ? typeIcon('storage_types', st.type) : (scopeOf(st) === 'remote' ? 'cloud' : 'archive'));

/* ------------------------------------------------- аватары организаций
   Цвет по умолчанию вычисляется из тега, в форме организации можно выбрать другой. */
const ORG_COLORS = [
  ['blue', 'синий', '#2563eb'], ['indigo', 'индиго', '#4f46e5'], ['sky', 'голубой', '#0369a1'],
  ['teal', 'бирюзовый', '#0f766e'], ['pink', 'розовый', '#be185d'], ['fuchsia', 'пурпурный', '#a21caf'],
  ['rust', 'кирпичный', '#c2410c'], ['brown', 'коричневый', '#854d0e'], ['slate', 'сланцевый', '#475569'],
  ['graphite', 'графит', '#3f3f46'],
];
const COLOR_HEX = Object.fromEntries(ORG_COLORS.map(([k, , h]) => [k, h]));
function hashStr(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
const autoColor = (org) => ORG_COLORS[hashStr((String(org.tag || '').replace(/^#/, '') || org.name || '').toLowerCase())
  % ORG_COLORS.length][0];
const orgColor = (org) => (COLOR_HEX[org.color] ? org.color : autoColor(org));
const normTag = (t) => { const v = String(t || '').trim().replace(/\s/g, ''); return v && !v.startsWith('#') ? `#${v}` : v; };
function orgInitials(org) {
  const tag = String(org.tag || '').replace(/^#/, '').trim();
  if (tag) return tag.slice(0, 3).toUpperCase();
  const words = String(org.name || '').replace(/[«»"'„“”()]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !/^(ооо|оао|зао|пао|ао|ип|нко|ано|гуп|муп)$/i.test(w));
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}
function avatarHtml(org, size = 'm') {
  const t = orgInitials(org);
  return `<span class="avatar av-${size} len-${t.length}" style="--av:${COLOR_HEX[orgColor(org)]}" aria-hidden="true">${esc(t)}</span>`;
}

function storageUsages(storageId, orgId) {
  const out = [];
  for (const { org, dev, set } of state.idx.set.values()) {
    if (orgId && org.id !== orgId) continue;
    set.copies.forEach((c, i) => {
      if (c.storage_id === storageId) out.push({ org, dev, set, copy: c, no: i + 1 });
    });
  }
  return out;
}

/* статус копии (этап внедрения): защитой считаются только действующие копии;
   копии без поля stage созданы до появления статусов — они действующие */
const stageOf = (c) => (c.stage && state.meta.copy_stages[c.stage] ? c.stage : 'active');
const isActive = (c) => stageOf(c) === 'active';
const STAGE_SHORT = { approval: 'согласование', planned: 'в плане', active: 'действует' };
function stageSummary(copies) {
  const n = { approval: 0, planned: 0 };
  for (const c of copies) if (stageOf(c) in n) n[stageOf(c)]++;
  return [n.approval && `${plural(n.approval, 'копия', 'копии', 'копий')} на согласовании`,
    n.planned && `${plural(n.planned, 'копия', 'копии', 'копий')} в плане`].filter(Boolean).join(', ');
}

/* статус набора: bad — нет действующих копий, warn — нет действующей удалённой, ok — есть offsite.
   Копия без выбранного хранилища (в форме, ещё не сохранена) не защищает. */
const STATUS = {
  none: { rank: -1, text: 'нет наборов', hint: 'В организации пока нет наборов' },
  ok: { rank: 0, text: 'в порядке', hint: 'Есть действующая копия на удалённом хранилище' },
  warn: { rank: 1, text: 'нет offsite', hint: 'Нет действующей копии на удалённом (offsite) хранилище' },
  bad: { rank: 2, text: 'нет копий', hint: 'Копии не настроены' },
};
function setStatus(set) {
  const active = set.copies.filter((c) => isActive(c) && c.storage_id);
  if (!active.length) return 'bad';
  return active.some((c) => state.idx.st.get(c.storage_id)?.scope === 'remote') ? 'ok' : 'warn';
}
/* «нет копий» и «копии есть, но ни одна ещё не действует» — разные ситуации */
function setStatusHtml(set, s = setStatus(set)) {
  if (s === 'bad' && set.copies.some((c) => c.storage_id)) {
    return `<span class="status s-bad" title="Копии описаны, но ни одна ещё не действует (согласование или в плане)">`
      + '<i class="sym" aria-hidden="true"></i>не внедрено</span>';
  }
  return statusHtml(s);
}
function worst(list) {
  let w = 'none';
  for (const s of list) if (STATUS[s].rank > STATUS[w].rank) w = s;
  return w;
}
const orgStatus = (org) => worst(orgSets(org).map(setStatus));
const statusHtml = (s, text) => `<span class="status s-${s}" title="${esc(STATUS[s].hint)}">`
  + `<i class="sym" aria-hidden="true"></i>${esc(text ?? STATUS[s].text)}</span>`;

/* подсветка совпадений поиска */
function hl(value) {
  const s = String(value ?? '');
  const q = state.search.trim().toLowerCase();
  if (!q) return esc(s);
  const lower = s.toLowerCase();
  let out = '', i = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    out += esc(s.slice(i, j)) + '<mark>' + esc(s.slice(j, j + q.length)) + '</mark>';
    i = j + q.length;
  }
  return out + esc(s.slice(i));
}
const has = (q, ...vals) => vals.some((v) => String(v || '').toLowerCase().includes(q));
function orgMatches(org, q) {
  if (!q) return true;
  if (has(q, org.name, org.tag, org.notes)) return true;
  return org.devices.some((d) => has(q, d.name, d.host, d.role, d.os, d.location, d.notes)
    || d.sets.some((s) => has(q, s.name, s.source, s.notes, label('set_types', s.type))));
}

/* уведомление; actions — кнопка или список кнопок { label, fn } */
function toast(msg, kind = '', actions = null) {
  const list = actions ? [].concat(actions) : [];
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(text);
  for (const a of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = a.label;
    b.addEventListener('click', () => { el.remove(); a.fn(); });
    el.append(b);
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), list.length || kind === 'error' ? 8000 : 2600);
}

/* ------------------------------------------------------------ routing
   #                       обзор
   #new                    новая организация
   #org/<id>               план организации
   #org/<id>/set/<id>      то же + прокрутка и подсветка набора
   #storages[/<id>]        справочник хранилищ (+ раскрытая форма хранилища)
   #dicts                  справочники значений                            */
function route() {
  const parts = location.hash.slice(1).split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const [a, b, c, d] = parts;
  if (a === 'new') return { page: 'neworg' };
  if (a === 'org' && b) return { page: 'org', orgId: b, setId: c === 'set' ? d || null : null };
  if (a === 'storages') return { page: 'storages', stId: b || null };
  if (a === 'dicts') return { page: 'dicts' };
  // старые адреса
  if (a === 'dev' && state.idx.dev.has(b)) return redirect(`org/${state.idx.dev.get(b).org.id}`);
  if (a === 'set' && state.idx.set.has(b)) return redirect(`org/${state.idx.set.get(b).org.id}/set/${b}`);
  if (a === 'st') return redirect(b ? `storages/${b}` : 'storages');
  return { page: 'overview' };
}
function redirect(hash) { location.replace('#' + hash); return null; }
function go(hash) {
  if (location.hash.slice(1) === hash) render();
  else location.hash = hash;
}
/* форма, которая открывается по адресу: карточка хранилища и новая организация */
function routeEditorKey(r) {
  if (r?.page === 'storages' && r.stId) return `st:${r.stId}`;
  if (r?.page === 'neworg') return 'org:new';
  return null;
}

/* ============================================================== RENDER */
function render() {
  if (!state.data) return;
  const r = route();
  if (!r) return;
  closePopover();
  // форма по адресу закрывается, когда адрес сменился (если в ней нет правок)
  if (ED?.routeBound && !ED.dirty && routeEditorKey(r) !== ED.key) ED = null;
  renderNav(r);
  const main = $('#main');
  const focus = captureFocus();
  let title = 'План резервного копирования';
  if (r.page === 'org') {
    const org = state.idx.org.get(r.orgId);
    main.innerHTML = org ? viewOrg(org) : notFound('Организация не найдена', 'Возможно, её удалили. Выберите организацию в списке слева.');
    if (org) title = `${org.name} — план копирования`;
  } else if (r.page === 'storages') {
    main.innerHTML = viewStorages();
    title = 'Хранилища — план копирования';
  } else if (r.page === 'dicts') {
    main.innerHTML = viewDicts();
    title = 'Справочники — план копирования';
  } else if (r.page === 'neworg') {
    main.innerHTML = viewNewOrg();
    title = 'Новая организация — план копирования';
  } else {
    main.innerHTML = viewOverview();
  }
  document.title = title;
  mountEditor();
  restoreFocus(focus);
  doFlash();
  ensureRouteEditor(r);
}

/* перерисовка страницы вынимает форму из документа — фокус и курсор возвращаем на место */
function captureFocus() {
  const a = document.activeElement;
  if (!ED || !a || !ED.el.contains(a)) return null;
  let s = null, e = null;
  try { s = a.selectionStart; e = a.selectionEnd; } catch { /* у этого поля нет курсора */ }
  return { a, s, e };
}
function restoreFocus(f) {
  if (!f || !f.a.isConnected || document.activeElement === f.a) return;
  f.a.focus({ preventScroll: true });
  try { if (f.s != null) f.a.setSelectionRange(f.s, f.e); } catch { /* у этого поля нет курсора */ }
}

function renderNav(r) {
  $$('.nav-link').forEach((a) => {
    const on = a.dataset.nav === r.page;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#st-count').textContent = state.data.storages.length || '';

  const q = state.search.trim().toLowerCase();
  const orgs = [...state.data.organizations].sort(byName).filter((o) => orgMatches(o, q));
  $('#org-list').innerHTML = orgs.map((o) => {
    const s = orgStatus(o);
    const cur = r.page === 'org' && r.orgId === o.id ? ' aria-current="page"' : '';
    return `<li><a class="org-link" href="#org/${esc(o.id)}"${cur} title="${esc([o.name, o.tag].filter(Boolean).join(' '))}">
      ${avatarHtml(o, 's')}
      <span class="org-link-name">${hl(o.name)}</span>
      <span class="org-link-st s-${s}" title="${esc(STATUS[s].hint)}"><i class="sym" aria-hidden="true"></i><span class="sr-only">${esc(STATUS[s].text)}</span></span></a></li>`;
  }).join('') || `<li class="nav-empty">${state.data.organizations.length
    ? 'Ничего не найдено. Поиск идёт по названиям, тегам, устройствам, IP и путям.'
    : 'Организаций пока нет.'}</li>`;

  const t = state.data.updated_at ? new Date(state.data.updated_at).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  $('#updated').textContent = t ? `Изменено ${t}` : '';
  $$('#theme-switch [role=radio]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === state.theme)));
}

const notFound = (title, text) => `<div class="page not-found">
  <h1 class="display">${esc(title)}</h1><p>${esc(text)}</p><a class="btn" href="#">Открыть обзор</a></div>`;

function doFlash() {
  const f = state.flash;
  if (!f) return;
  state.flash = null;
  const el = $(`[data-key="${CSS.escape(f.key)}"]`, $('#main'));
  if (!el) return;
  el.scrollIntoView({ block: f.scroll || 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1900);
  const t = el.matches('[data-focus]') ? el : $('[data-focus]', el);
  if (!ED) t?.focus({ preventScroll: true });
}

/* --------------------------------------------------------------- обзор */
function ribbon(counts, total) {
  if (!total) return '<div class="ribbon empty" aria-hidden="true"></div>';
  return `<div class="ribbon" aria-hidden="true">${['ok', 'warn', 'bad'].filter((k) => counts[k])
    .map((k) => `<i class="r-${k}" style="flex:${counts[k]}"></i>`).join('')}</div>`;
}
const countStatuses = (sets) => sets.reduce((acc, s) => { acc[setStatus(s)]++; return acc; }, { ok: 0, warn: 0, bad: 0 });

function viewOverview() {
  const d = state.data;
  if (!d.organizations.length) {
    return `<div class="page hero-empty">
      <h1 class="display">План пока пуст</h1>
      <p>Добавьте первую организацию, затем её серверы и то, что с них копируется.</p>
      <button type="button" class="btn btn-primary" data-act="add-org">+ Организация</button></div>`;
  }
  const rows = [...state.idx.set.values()].map((x) => ({ ...x, status: setStatus(x.set) }));
  const counts = countStatuses(rows.map((r) => r.set));
  const nCopies = rows.reduce((n, r) => n + r.set.copies.length, 0);
  const usedSt = new Set(rows.flatMap((r) => r.set.copies.map((c) => c.storage_id))).size;
  const att = rows.filter((r) => r.status !== 'ok').sort((a, b) =>
    STATUS[b.status].rank - STATUS[a.status].rank || byName(a.org, b.org) || byName(a.set, b.set));

  const headline = rows.length
    ? `${plural(rows.length, 'набор', 'набора', 'наборов')} в ${plural(d.organizations.length, 'организации', 'организациях', 'организациях')}`
    : `${plural(d.organizations.length, 'организация', 'организации', 'организаций')}, наборов пока нет`;
  const lead = `${plural(state.idx.dev.size, 'устройство', 'устройства', 'устройств')}, `
    + `${plural(nCopies, 'копия', 'копии', 'копий')} на ${plural(usedSt, 'хранилище', 'хранилищах', 'хранилищах')}.`
    + (() => { const p = stageSummary(rows.flatMap((r) => r.set.copies)); return p ? ` Ещё не действуют: ${p}.` : ''; })();

  const attHtml = att.length
    ? `<ul class="att-list">${att.map(({ org, dev, set, status }) => `<li>
        <a class="att-row st-${status}" href="#org/${esc(org.id)}/set/${esc(set.id)}">
          <span>${setStatusHtml(set, status)}</span>
          <span class="att-what"><span class="att-name">${icon(typeIcon('set_types', set.type), 16)}<b>${esc(set.name)}</b></span>
            <span class="att-where">${avatarHtml(org, 'xs')}${esc(org.name)} / ${esc(dev.name)}</span></span>
        </a></li>`).join('')}</ul>`
    : `<p class="all-good">${statusHtml('ok', '')} У каждого набора есть действующая копия на удалённом хранилище.</p>`;

  const orgRows = [...d.organizations].sort(byName).map((org) => {
    const sets = orgSets(org);
    return `<li><a class="ov-org" href="#org/${esc(org.id)}">
      <span class="ov-org-name">${avatarHtml(org, 'm')}<span>${esc(org.name)}</span><span class="tag">${esc(org.tag)}</span></span>
      <span class="ov-org-counts">${plural(org.devices.length, 'устройство', 'устройства', 'устройств')}, ${plural(sets.length, 'набор', 'набора', 'наборов')}</span>
      ${ribbon(countStatuses(sets), sets.length)}</a></li>`;
  }).join('');

  return `<div class="page">
    <header class="page-head">
      <h1 class="display ov-headline">${headline}</h1>
      <p class="lead">${lead}</p>
      ${rows.length ? `${ribbon(counts, rows.length)}
      <div class="legend">
        <span>${statusHtml('ok', '')}<b>${counts.ok}</b> в порядке</span>
        <span><span class="s-warn"><i class="sym"></i></span><b>${counts.warn}</b> без offsite-копии</span>
        <span><span class="s-bad"><i class="sym"></i></span><b>${counts.bad}</b> без действующих копий</span>
      </div>` : ''}
    </header>
    <section class="ov-block" aria-labelledby="att-title">
      <h2 class="section-title" id="att-title">Требует внимания${att.length ? ` <span class="count">${att.length}</span>` : ''}</h2>
      ${attHtml}
    </section>
    <section class="ov-block" aria-labelledby="orgs-title">
      <h2 class="section-title" id="orgs-title">Организации <span class="count">${d.organizations.length}</span></h2>
      <ul class="ov-orgs">${orgRows}</ul>
    </section></div>`;
}

/* ------------------------------------------------- новая организация */
function viewNewOrg() {
  const o = ED?.key === 'org:new' && ED.live ? ED.live : { name: '', tag: '' };
  return `<div class="page">
    <header class="page-head">
      <h1 class="display">Новая организация</h1>
      <p class="lead">Название и тег. После создания добавьте устройства и то, что с них копируется.</p>
    </header>
    <div class="ed-card is-open" data-card data-key="org:new">
      <div class="ed-card-head new-org-head">
        <span data-live="avatar" data-size="l">${avatarHtml(o, 'l')}</span>
        <div><div class="new-org-name display" data-live="name">${esc(o.name || 'Без названия')}</div>
          <div class="tag" data-live="tag">${esc(normTag(o.tag))}</div></div>
      </div>
      <div class="ed-slot" data-slot="org:new"></div>
    </div></div>`;
}

/* --------------------------------------------------------- организация */
/* цепочка копий; edit — в шапке раскрытого набора: номера копий, клик ведёт к строке копии */
function chainHtml(copies, { edit = false } = {}) {
  const ids = new Set(copies.map((c) => c.id));
  const seen = new Set();
  const kidsOf = (id) => copies.filter((c) => !seen.has(c.id)
    && (id === 'source' ? (c.from === 'source' || !ids.has(c.from)) : c.from === id));
  const node = (c) => {
    seen.add(c.id);
    const inner = kidsOf(c.id).map(node).join('');
    return `<div class="ch-kid"><div class="ch-node">${pillHtml(c, copies.indexOf(c) + 1, edit)}${
      inner ? `<div class="ch-kids">${inner}</div>` : ''}</div></div>`;
  };
  const roots = kidsOf('source');
  const body = roots.length
    ? `<div class="ch-kids">${roots.map(node).join('')}</div>`
    : `<span class="ch-none">${edit ? 'копий пока нет' : 'копий нет — набор не защищён'}</span>`;
  return `<div class="chain"><div class="ch-node"><span class="ch-src">источник</span>${body}</div></div>`;
}

function pillHtml(c, n, edit) {
  const st = state.idx.st.get(c.storage_id);
  const no = edit ? `<span class="pill-no">${n}</span>` : '';
  if (!st) {
    const inner = `<span class="pill-l1">${no}<span class="pill-name">${c.storage_id ? 'хранилище удалено' : 'хранилище не выбрано'}</span></span>`;
    return edit ? `<button type="button" class="pill missing" data-act="focus-copy" data-id="${esc(c.id)}">${inner}</button>`
      : `<span class="pill missing">${inner}</span>`;
  }
  const scope = scopeOf(st);
  const stage = stageOf(c);
  const when = [c.schedule, c.retention && `хранить: ${c.retention}`].filter(Boolean);
  const title = [`${st.name} (${SCOPE_TEXT[scope]})`, `Статус: ${state.meta.copy_stages[stage]}`, st.address, c.tool && `Инструмент: ${c.tool}`,
    c.schedule && `Расписание: ${c.schedule}`, c.retention && `Хранение: ${c.retention}`, c.notes].filter(Boolean).join('\n');
  const inner = `<span class="pill-l1">${no}${icon(stIcon(st), 15, 'pill-ico')}<span class="pill-name">${hl(st.name)}</span>`
    + (stage === 'active' ? `<span class="pill-scope">${SCOPE_TEXT[scope]}</span>`
      : `<span class="pill-stage">${STAGE_SHORT[stage]}</span>`) + '</span>'
    + `<span class="pill-l2">${when.length ? esc(when.join(', ')) : 'расписание не указано'}</span>`
    + `<span class="pill-l3">${c.tool ? esc(c.tool) : 'инструмент не указан'}</span>`;
  const act = edit ? `data-act="focus-copy" data-id="${esc(c.id)}"` : `data-act="pop-st" data-id="${esc(st.id)}" aria-haspopup="dialog"`;
  return `<button type="button" class="pill ${scope} stage-${stage}" ${act} title="${esc(title)}">${inner}</button>`;
}

/* строка набора; open — шапка раскрытой формы (обновляется на лету, пока правишь) */
function setRowHtml(set, { open = false } = {}) {
  const s = setStatus(set);
  const act = open ? 'data-act="collapse"' : `data-act="edit-set" data-id="${esc(set.id)}"`;
  const name = String(set.name || '').trim();
  return `<div class="set st-${s}${open ? ' set-head' : ''}"${open ? '' : ` id="set-${esc(set.id)}" data-key="set:${esc(set.id)}"`} ${act}>
    <div class="set-what">
      <div class="set-title">${icon(typeIcon('set_types', set.type), 17, 'set-ico')}
        <button type="button" class="set-name${name ? '' : ' empty'}" ${act}${open ? ' title="Свернуть"' : ' data-focus'}>${name ? hl(name) : 'Новый набор'}</button></div>
      <div class="set-type">${esc(label('set_types', set.type))}</div>
      ${set.source ? `<code class="set-src">${hl(set.source)}</code>` : ''}
    </div>
    <div class="set-chain">${chainHtml(set.copies, { edit: open })}</div>
    <div class="set-status">${setStatusHtml(set, s)}</div>
  </div>`;
}
const setCardHtml = (key, set) => `<div class="set-card ed-card is-open" data-card data-key="${esc(key)}">
  ${setRowHtml(set, { open: true })}<div class="ed-slot" data-slot="${esc(key)}"></div></div>`;

function deviceHtml(dev) {
  const key = `dev:${dev.id}`;
  const open = ED?.key === key;
  const kind = kindShort(dev.kind);
  const system = [kind && esc(kind), dev.os && hl(dev.os)].filter(Boolean).join(' / ');
  const meta = [
    dev.role && `<span>${hl(dev.role)}</span>`,
    dev.host && `<code>${hl(dev.host)}</code>`,
    system && `<span>${system}</span>`,
  ].filter(Boolean).join('');
  const rows = dev.sets.map((set) => {
    const k = `set:${set.id}`;
    return ED?.key === k ? setCardHtml(k, { ...set, ...ED.live }) : setRowHtml(set);
  });
  const nk = `set:new:${dev.id}`;
  if (ED?.key === nk) rows.push(setCardHtml(nk, { id: '', ...ED.live }));
  return `<article class="device${open ? ' is-open' : ''}" data-key="${esc(key)}">
    <div class="device-top"${open ? ' data-card' : ''}>
      <header class="device-head">
        <span class="dev-ico" title="${esc(label('device_kinds', dev.kind) || 'Тип не указан')}">${icon(typeIcon('device_kinds', dev.kind), 20)}</span>
        <div class="device-id">
          <h2 class="device-title"><button type="button" class="device-name display" data-act="${open ? 'collapse' : 'edit-dev'}"
            data-id="${esc(dev.id)}"${open ? ' title="Свернуть"' : ' data-focus title="Изменить устройство"'}>${hl(dev.name)}</button></h2>
          ${meta ? `<div class="device-meta">${meta}</div>` : ''}
        </div>
        <button type="button" class="btn btn-s device-add" data-act="add-set" data-id="${esc(dev.id)}">+ Набор</button>
      </header>
      ${open ? `<div class="ed-slot dev-slot" data-slot="${esc(key)}"></div>` : ''}
    </div>
    ${rows.length ? `<div class="sets">${rows.join('')}</div>`
      : `<p class="device-empty">Не указано, что копируется с этого устройства. <button type="button" class="link-btn" data-act="add-set" data-id="${esc(dev.id)}">Добавить набор</button></p>`}
  </article>`;
}

function viewOrg(org) {
  const okey = `org:${org.id}`;
  const oOpen = ED?.key === okey;
  const o = oOpen && ED.live ? { ...org, ...ED.live } : org;
  const sets = orgSets(org);
  const nAtt = sets.filter((s) => setStatus(s) !== 'ok').length;
  const summary = [
    `<span>${plural(org.devices.length, 'устройство', 'устройства', 'устройств')}</span>`,
    `<span>${plural(sets.length, 'набор', 'набора', 'наборов')}</span>`,
    (() => { const p = stageSummary(sets.flatMap((x) => x.copies)); return p ? `<span>${p}</span>` : ''; })(),
    sets.length ? (nAtt
      ? statusHtml(orgStatus(org), plural(nAtt, 'требует внимания', 'требуют внимания', 'требуют внимания'))
      : statusHtml('ok', 'всё в порядке')) : '',
  ].join('');

  const devices = [...org.devices].sort(byName).map(deviceHtml).join('');
  const nk = `dev:new:${org.id}`;
  const newDev = ED?.key === nk ? `<article class="device is-open is-new" data-key="${esc(nk)}">
      <div class="device-top" data-card>
        <header class="device-head"><span class="dev-ico">${icon('server', 20)}</span>
          <div class="device-id"><h2 class="device-title display">Новое устройство</h2>
            <div class="device-meta"><span>Сервер, ВМ или ПК, с которого копируются данные</span></div></div></header>
        <div class="ed-slot dev-slot" data-slot="${esc(nk)}"></div>
      </div></article>` : '';

  const sts = orgStorages(org.id);
  const chips = sts.map((st) => {
    const used = storageUsages(st.id, org.id).length;
    const scope = scopeOf(st);
    return `<span class="st-chip ${scope}">
      <button type="button" class="st-chip-main" data-act="pop-st" data-id="${esc(st.id)}" aria-haspopup="dialog">
        ${icon(stIcon(st), 15, 'chip-ico')}<span class="st-chip-name">${hl(st.name)}</span>
        <span class="st-chip-meta">${SCOPE_TEXT[scope]}, ${used ? plural(used, 'копия', 'копии', 'копий') : 'не используется'}</span>
      </button><button type="button" class="st-chip-x" data-act="detach-st" data-id="${esc(st.id)}" data-org="${esc(org.id)}"
        title="Отключить от организации" aria-label="Отключить ${esc(st.name)} от организации">×</button></span>`;
  }).join('');
  const sk = ED?.key;
  const stEdit = sk === `st:new:${org.id}` || sk === `attach:${org.id}`
    ? `<div class="ed-card is-open st-org-card" data-card data-key="${esc(sk)}">
        <div class="ed-card-head"><div class="ed-card-title">${sk.startsWith('attach')
          ? 'Подключить хранилища из общего справочника' : `Новое хранилище для «${esc(org.name)}»`}</div></div>
        <div class="ed-slot" data-slot="${esc(sk)}"></div></div>` : '';

  return `<div class="page">
    <header class="org-head${oOpen ? ' is-open ed-card' : ''}" data-key="${esc(okey)}"${oOpen ? ' data-card' : ''}>
      <div class="org-head-main">
        <span data-live="avatar" data-size="l">${avatarHtml(o, 'l')}</span>
        <div class="org-head-text">
          <h1 class="org-title display"><span data-live="name">${hl(o.name)}</span><span class="tag" data-live="tag">${hl(normTag(o.tag))}</span></h1>
          <div class="org-summary">${summary}</div>
          ${org.notes && !oOpen ? `<p class="org-notes">${hl(org.notes)}</p>` : ''}
        </div>
        ${oOpen ? '' : `<button type="button" class="btn" data-act="edit-org" data-id="${esc(org.id)}" data-focus>Изменить</button>`}
      </div>
      ${oOpen ? `<div class="ed-slot" data-slot="${esc(okey)}"></div>` : ''}
    </header>
    ${devices || newDev ? `<div class="devices">${devices}${newDev}</div>`
      : '<p class="device-empty lone">Добавьте устройство — сервер, ВМ или ПК, с которого копируются данные.</p>'}
    ${newDev ? '' : `<button type="button" class="btn add-device" data-act="add-dev" data-id="${esc(org.id)}">+ Устройство</button>`}
    <section class="org-storages" aria-labelledby="org-st-title">
      <div class="org-storages-head">
        <h2 class="section-title" id="org-st-title">Доступные хранилища <span class="count">${sts.length}</span></h2>
        <button type="button" class="btn btn-s" data-act="add-st-org" data-id="${esc(org.id)}">+ Создать</button>
        <button type="button" class="btn btn-s" data-act="attach-st" data-id="${esc(org.id)}">Подключить</button>
      </div>
      ${stEdit}
      ${chips ? `<div class="st-chips">${chips}</div>`
        : '<p class="st-empty">Копии можно класть только на доступные хранилища. Создайте новое или подключите существующее из общего справочника.</p>'}
    </section></div>`;
}

/* ----------------------------------------------------------- хранилища */
function viewStorages() {
  const q = state.search.trim().toLowerCase();
  const editId = /^st:(?!new)/.test(ED?.key || '') ? ED.key.slice(3) : null;
  const list = [...state.data.storages].sort(byName).filter((s) => s.id === editId || !q
    || has(q, s.name, s.address, s.location, s.notes, label('storage_types', s.type)));
  const rows = list.map((st) => {
    const key = `st:${st.id}`;
    const open = ED?.key === key;
    const act = open ? 'collapse' : 'open-st';
    const orgs = st.org_ids.map((id) => state.idx.org.get(id)).filter(Boolean).sort(byName);
    const used = storageUsages(st.id).length;
    const scope = scopeOf(st);
    return `<tbody class="st-body${open ? ' is-open' : ''}" data-key="${esc(key)}"${open ? ' data-card' : ''}>
      <tr data-act="${act}" data-id="${esc(st.id)}">
        <td><div class="st-cell"><span class="st-ico ${scope}">${icon(stIcon(st), 17)}</span><div>
          <button type="button" class="cell-btn" data-act="${act}" data-id="${esc(st.id)}"${open ? ' title="Свернуть"' : ' data-focus'}>${hl(st.name)}</button>
          ${st.location ? `<span class="cell-sub">${hl(st.location)}</span>` : ''}</div></div></td>
        <td>${esc(label('storage_types', st.type)) || '<span class="muted">—</span>'}</td>
        <td><span class="scope-badge ${scope}">${ICON[scope]}${SCOPE_TEXT[scope]}</span></td>
        <td>${st.address ? `<code>${hl(st.address)}</code>` : '<span class="muted">—</span>'}</td>
        <td>${orgs.length ? `<span class="tags">${orgs.map((o) => `<span class="org-chip" style="--av:${COLOR_HEX[orgColor(o)]}" title="${esc(o.name)}"><i aria-hidden="true"></i>${esc(o.tag || o.name)}</span>`).join('')}</span>`
          : '<span class="nobody">никому</span>'}</td>
        <td class="num">${used || '<span class="muted">0</span>'}</td></tr>
      ${open ? `<tr class="ed-row"><td colspan="6"><div class="ed-slot" data-slot="${esc(key)}"></div></td></tr>` : ''}
    </tbody>`;
  }).join('');
  const newCard = ED?.key === 'st:new' ? `<div class="ed-card is-open st-new-card" data-card data-key="st:new">
      <div class="ed-card-head"><div class="ed-card-title">Новое хранилище</div>
        <div class="ed-card-sub">Появится в общем справочнике. Ниже отметьте организации, которым оно доступно.</div></div>
      <div class="ed-slot" data-slot="st:new"></div></div>` : '';

  return `<div class="page">
    <header class="page-head page-head-row">
      <div><h1 class="display">Хранилища</h1>
        <p class="lead">Общий справочник мест хранения. Хранилище можно выбрать в копии только у тех организаций, которым оно доступно.</p></div>
      <button type="button" class="btn btn-primary" data-act="add-st">+ Хранилище</button>
    </header>
    ${newCard}
    ${rows ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Хранилище</th><th>Тип</th><th>Размещение</th><th>Адрес</th><th>Доступно</th><th class="num">Копий</th></tr></thead>
      ${rows}</table></div>`
      : `<p class="muted">${state.data.storages.length ? 'Ничего не найдено.' : 'Хранилищ пока нет. Добавьте NAS, сетевую папку или облако, куда кладутся копии.'}</p>`}
  </div>`;
}

/* ---------------------------------------------------------- справочники */
/* сколько раз значение справочника-«кода» встречается в данных */
function dictUsageCount(name, id) {
  if (name === 'storage_types') return state.data.storages.filter((s) => s.type === id).length;
  let n = 0;
  for (const { dev } of state.idx.dev.values()) {
    if (name === 'device_kinds' && dev.kind === id) n++;
    if (name === 'set_types') n += dev.sets.filter((s) => s.type === id).length;
  }
  return n;
}
const DICT_UNITS = {
  set_types: ['набор', 'набора', 'наборов'],
  storage_types: ['хранилище', 'хранилища', 'хранилищ'],
  device_kinds: ['устройство', 'устройства', 'устройств'],
};

function viewDicts() {
  const card = ([name, sc]) => {
    const key = `dict:${name}`;
    if (ED?.key === key) {
      return `<li class="dict-open"><div class="ed-card is-open" data-card data-key="${esc(key)}">
        <div class="ed-card-head"><div class="ed-card-title">${esc(sc.title)}</div><div class="ed-card-sub">${esc(sc.about || '')}</div></div>
        <div class="ed-slot" data-slot="${esc(key)}"></div></div></li>`;
    }
    const items = state.dicts[name];
    const values = sc.kind === 'choice' ? items.map((i) => ({ text: i.label, ico: typeIcon(name, i.id) })) : items.map((v) => ({ text: v }));
    const shown = values.slice(0, 8);
    return `<li><button type="button" class="dict-card" data-act="edit-dict" data-id="${esc(name)}" data-key="${esc(key)}" data-focus>
      <span class="dict-card-head"><span class="dict-title">${esc(sc.title)}</span><span class="count">${values.length}</span></span>
      <span class="dict-about">${esc(sc.about || '')}</span>
      <span class="dict-values">${shown.map((v) => `<span class="dict-val">${v.ico ? icon(v.ico, 13) : ''}${esc(v.text)}</span>`).join('')}${
        values.length > shown.length ? `<span class="dict-more">ещё ${values.length - shown.length}</span>` : ''}
        ${values.length ? '' : '<span class="muted">пусто</span>'}</span>
    </button></li>`;
  };
  const group = (kind) => Object.entries(state.schema).filter(([, sc]) => sc.kind === kind).map(card).join('');
  return `<div class="page">
    <header class="page-head">
      <h1 class="display">Справочники</h1>
      <p class="lead">Значения для выпадающих списков и подсказок в формах. Хранятся отдельно от плана, в <code>data/dictionaries.json</code>.</p>
    </header>
    <section class="ov-block dict-block" aria-labelledby="dict-choice">
      <h2 class="section-title" id="dict-choice">Списки выбора</h2>
      <p class="dict-lead">Значение выбирается из списка, у каждого есть значок. Используемое значение можно переименовать, но нельзя удалить.</p>
      <ul class="dict-grid">${group('choice')}</ul>
    </section>
    <section class="ov-block dict-block" aria-labelledby="dict-list">
      <h2 class="section-title" id="dict-list">Подсказки при вводе</h2>
      <p class="dict-lead">Предлагаются в поле при вводе, но написать можно что угодно.</p>
      <ul class="dict-grid">${group('list')}</ul>
    </section>
    <p class="dict-foot muted">Размещение хранилища (локальное / удалённое) и статус копии (согласование / в плане / действует) — системные значения:
      от них зависит отметка «Требует внимания», поэтому они не редактируются.</p>
  </div>`;
}

function dictEditor(name) {
  const sc = state.schema[name];
  if (!sc) return;
  const body = document.createElement('div');
  let readItems;

  if (sc.kind === 'list') {
    body.innerHTML = `<section class="d-section">
      <p class="hint">По одному значению в строке; пустые строки и повторы уберутся при сохранении.</p>
      <label class="field wide"><span>Значения</span>
        <textarea class="ctl dict-text" name="items" rows="16" spellcheck="false">${esc(state.dicts[name].join('\n'))}</textarea></label>
      <div class="dict-tools"><button type="button" class="btn btn-s btn-ghost" data-sort>Упорядочить по алфавиту</button></div>
    </section>`;
    const ta = $('textarea', body);
    $('[data-sort]', body).addEventListener('click', () => {
      ta.value = ta.value.split('\n').map((v) => v.trim()).filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })).join('\n');
      if (ED) ED.dirty = true;
    });
    readItems = () => ta.value.split('\n').map((v) => v.trim()).filter(Boolean);
  } else {
    const items = structuredClone(state.dicts[name]);
    const hasIcon = 'icon' in (sc.fields || {});
    const extra = Object.entries(sc.fields || {}).filter(([k]) => k !== 'icon');
    const unit = DICT_UNITS[name] || ['запись', 'записи', 'записей'];
    const iconOf = (it) => (it.icon && ICONS[it.icon] ? it.icon : defaultIcon(name, it.id));
    let picking = -1;
    body.innerHTML = `<section class="d-section">
      <p class="hint">Используемое значение можно переименовать — в данных хранится его код, поэтому план не изменится.${
        hasIcon ? ' Значок показывается в плане: нажмите на него, чтобы выбрать другой.' : ''}</p>
      <ol class="dict-rows"></ol>
      <button type="button" class="btn btn-s" data-add-item>+ Значение</button>
    </section>`;
    const rowsEl = $('.dict-rows', body);
    const gridHtml = (it) => `<div class="icon-grid" role="radiogroup" aria-label="Значок для «${esc(it.label)}»">
      <button type="button" class="icon-opt auto" role="radio" aria-checked="${!(it.icon && ICONS[it.icon])}" data-icon=""
        title="Стандартный значок">${icon(defaultIcon(name, it.id), 18)}<span>стандартный</span></button>
      ${Object.entries(ICONS).map(([k, [t]]) => `<button type="button" class="icon-opt" role="radio" aria-checked="${it.icon === k}"
        data-icon="${k}" title="${esc(t)}" aria-label="${esc(t)}">${icon(k, 18)}</button>`).join('')}</div>`;
    const renderRows = (focus) => {
      rowsEl.innerHTML = items.map((it, i) => {
        const used = it.id ? dictUsageCount(name, it.id) : 0;
        return `<li class="dict-row${hasIcon ? ' with-icon' : ''}" data-i="${i}">
          ${hasIcon ? `<button type="button" class="icon-pick" data-icon-pick aria-expanded="${picking === i}"
            aria-label="Значок для строки ${i + 1}: ${esc(ICONS[iconOf(it)][0])}" title="Выбрать значок">${icon(iconOf(it), 18)}</button>` : ''}
          <div class="dict-row-fields">
            <input class="ctl ctl-s dict-label" data-f="label" value="${esc(it.label)}" placeholder="Название" aria-label="Название, строка ${i + 1}" autocomplete="off">
            ${extra.map(([k, l]) => `<input class="ctl ctl-s dict-x-${esc(k)}" data-f="${esc(k)}" value="${esc(it[k] || '')}"
              placeholder="${esc(l)}" title="${esc(l)}" aria-label="${esc(l)}, строка ${i + 1}" autocomplete="off">`).join('')}
            <span class="dict-used">${used ? `используется: ${plural(used, ...unit)}` : (it.id ? 'не используется' : 'новое значение')}</span>
          </div>
          <div class="dict-row-tools">
            <button type="button" class="icon-btn" data-move="-1" aria-label="Выше" title="Выше"${i ? '' : ' disabled'}>↑</button>
            <button type="button" class="icon-btn" data-move="1" aria-label="Ниже" title="Ниже"${i < items.length - 1 ? '' : ' disabled'}>↓</button>
            <button type="button" class="icon-btn" data-del-item aria-label="Удалить «${esc(it.label)}»"
              title="${used ? 'Значение используется — удалить нельзя' : 'Удалить'}"${used ? ' disabled' : ''}>×</button>
          </div>
          ${picking === i ? gridHtml(it) : ''}</li>`;
      }).join('');
      if (focus) $(`[data-i="${focus.i}"] ${focus.sel}`, rowsEl)?.focus();
    };
    renderRows();
    rowsEl.addEventListener('input', (e) => {
      const row = e.target.closest('[data-i]');
      if (row && e.target.dataset.f) items[+row.dataset.i][e.target.dataset.f] = e.target.value;
    });
    rowsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !e.target.closest('.icon-grid')) return;
      e.preventDefault();
      e.stopPropagation();
      const i = picking;
      picking = -1;
      renderRows({ i, sel: '[data-icon-pick]' });
    });
    rowsEl.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      const row = b?.closest('[data-i]');
      if (!row || b.disabled) return;
      const i = +row.dataset.i;
      if (b.hasAttribute('data-icon-pick')) {
        picking = picking === i ? -1 : i;
        renderRows({ i, sel: picking === i ? '.icon-opt[aria-checked="true"]' : '[data-icon-pick]' });
        return;
      }
      if (b.dataset.icon !== undefined) {
        items[i].icon = b.dataset.icon;
        picking = -1;
        renderRows({ i, sel: '[data-icon-pick]' });
      } else if (b.dataset.move) {
        const j = i + Number(b.dataset.move);
        [items[i], items[j]] = [items[j], items[i]];
        picking = -1;
        renderRows();
        const same = $(`[data-i="${j}"] [data-move="${b.dataset.move}"]`, rowsEl);
        (same && !same.disabled ? same : $(`[data-i="${j}"] [data-move]:not([disabled])`, rowsEl))?.focus();
      } else if (b.hasAttribute('data-del-item')) {
        items.splice(i, 1);
        picking = -1;
        renderRows(items.length ? { i: Math.min(i, items.length - 1), sel: '[data-f=label]' } : null);
      }
      if (ED) ED.dirty = true;
    });
    $('[data-add-item]', body).addEventListener('click', () => {
      items.push({ id: '', label: '', ...(hasIcon ? { icon: '' } : {}), ...Object.fromEntries(extra.map(([k]) => [k, ''])) });
      picking = -1;
      renderRows({ i: items.length - 1, sel: '[data-f=label]' });
      if (ED) ED.dirty = true;
    });
    readItems = () => {
      items.forEach((it, i) => {
        if (!it.label.trim()) {
          $(`[data-i="${i}"] [data-f=label]`, rowsEl)?.focus();
          throw new Error(`Строка ${i + 1}: укажите название.`);
        }
      });
      return items;
    };
  }

  openEditor({
    key: `dict:${name}`,
    title: sc.title,
    body,
    onSubmit: async () => {
      const res = await api('PUT', `/api/dicts/${name}`, { items: readItems() });
      applyDicts(res);
    },
    onSaved: () => { toast('Справочник сохранён'); state.flash = { key: `dict:${name}`, scroll: 'nearest' }; render(); },
  });
}

/* ======================================================= РЕДАКТОР В СТРОКЕ
   Одна форма за раз. Страница рисует под строкой «слот» (data-slot = ключ
   формы), форма — живой узел DOM, который после каждой перерисовки
   возвращается в свой слот. Если слота нет (ушли на другую страницу),
   форма без правок закрывается, а с правками ждёт возвращения.          */
let ED = null;

function openEditor(cfg) {
  if (ED && ED.key === cfg.key) {
    if (ED.el.isConnected) { revealEditor(); focusFirst(); }
    return true;
  }
  if (ED && ED.dirty) { nudgeEditor(); return false; }
  closePopover();
  // форма, не связанная с адресом, на странице хранилищ — убираем из адреса открытую карточку
  const r = route();
  if (!cfg.routeBound && r?.page === 'storages' && r.stId) history.replaceState(null, '', '#storages');

  const del = cfg.del;
  const form = document.createElement('form');
  form.className = 'ied';
  form.noValidate = true;
  form.innerHTML = `<div class="ied-body"></div>
    <div class="ied-error" role="alert" hidden></div>
    <footer class="ied-foot">
      <div class="foot-main">
        ${del ? `<button type="button" class="btn btn-ghost btn-del" data-ed-del>${esc(del.label)}</button>` : ''}
        <span class="grow"></span>
        <span class="foot-hint">Esc — отмена</span>
        <button type="button" class="btn" data-ed-cancel>Отмена</button>
        <button type="submit" class="btn btn-primary">${esc(cfg.submitLabel || 'Сохранить')}</button>
      </div>
      ${del ? `<div class="foot-confirm" hidden>
        <p>${esc(del.question)}</p>
        <div class="foot-confirm-actions">
          <button type="button" class="btn" data-del-cancel>Не удалять</button>
          <button type="button" class="btn btn-danger" data-del-ok>${esc(del.label)}</button>
        </div></div>` : ''}
    </footer>`;
  const body = $('.ied-body', form);
  if (typeof cfg.body === 'string') body.innerHTML = cfg.body; else body.append(cfg.body);

  const cur = { ...cfg, el: form, dirty: false, hash: location.hash.slice(1) };
  ED = cur;
  const markDirty = () => { cur.dirty = true; };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!cur.onSubmit) return;
    hideEdError();
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const res = await cur.onSubmit(form);
      if (ED === cur) closeEditor({ restoreFocus: false, rerender: false });
      cur.onSaved?.(res);
    } catch (err) {
      if (ED === cur) showEdError(err);
    } finally {
      btn.disabled = false;
    }
  });
  $('[data-ed-cancel]', form).addEventListener('click', () => { if (ED === cur) closeEditor(); });
  if (del) {
    const main = $('.foot-main', form), confirm = $('.foot-confirm', form);
    $('[data-ed-del]', form).addEventListener('click', () => {
      hideEdError();
      const blocked = del.blocked?.();
      if (blocked) { showEdError(blocked); return; }
      main.hidden = true; confirm.hidden = false;
      $('[data-del-cancel]', form).focus();
    });
    $('[data-del-cancel]', form).addEventListener('click', hideConfirm);
    const okBtn = $('[data-del-ok]', form);
    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      try {
        await del.run();
        if (ED === cur) closeEditor({ restoreFocus: false, rerender: false });
        del.done?.();
      } catch (err) {
        if (ED === cur) { hideConfirm(); showEdError(err); }
      } finally {
        okBtn.disabled = false;
      }
    });
  }

  render();
  if (ED !== cur) return false;
  cfg.onOpen?.(form);
  if (!reduceMotion()) {
    form.classList.add('ied-enter');
    form.addEventListener('animationend', () => form.classList.remove('ied-enter'), { once: true });
  }
  revealEditor();
  focusFirst();
  return true;
}

function mountEditor() {
  if (!ED) return;
  const slot = $(`[data-slot="${CSS.escape(ED.key)}"]`, $('#main'));
  if (slot) slot.append(ED.el);
  else if (!ED.dirty) ED = null;
}

function closeEditor({ restoreFocus = true, rerender = true } = {}) {
  if (!ED) return;
  const { key, routeBound } = ED;
  ED = null;
  if (routeBound) {
    const r = route();
    if (r?.page === 'storages' && r.stId) history.replaceState(null, '', '#storages');
    else if (r?.page === 'neworg') history.replaceState(null, '', '#' + (state.prevHash && state.prevHash !== 'new' ? state.prevHash : ''));
  }
  if (rerender) render();
  if (restoreFocus) {
    const host = $(`[data-key="${CSS.escape(key)}"]`, $('#main'));
    const f = host && (host.matches('[data-focus]') ? host : $('[data-focus]', host));
    f?.focus({ preventScroll: true });
  }
}

/* клик по шапке раскрытой строки сворачивает форму, если в ней нет правок */
function collapseEditor() {
  if (!ED) return;
  if (ED.dirty) nudgeEditor(); else closeEditor();
}

function nudgeEditor() {
  if (!ED) return;
  const cur = ED;
  if (cur.el.isConnected) {
    revealEditor();
    const card = cur.el.closest('[data-card]') || cur.el;
    card.classList.remove('nudge');
    void card.offsetWidth;
    card.classList.add('nudge');
    card.addEventListener('animationend', () => card.classList.remove('nudge'), { once: true });
    toast('В открытой форме есть несохранённые изменения. Сохраните их или нажмите «Отмена».');
  } else {
    toast(`Остались несохранённые изменения: «${cur.title || 'форма'}».`, '', [
      { label: 'Вернуться', fn: () => go(cur.hash) },
      { label: 'Отменить правку', fn: () => { if (ED === cur) { ED = null; render(); } } },
    ]);
  }
}

/* прокрутить так, чтобы раскрытая карточка была видна (длинная — от начала) */
function revealEditor() {
  if (!ED?.el.isConnected) return;
  const card = ED.el.closest('[data-card]') || ED.el;
  const bar = $('.mobilebar');
  const top0 = (bar?.offsetHeight || 0) + 16;
  const r = card.getBoundingClientRect();
  let dy = 0;
  if (r.top < top0) dy = r.top - top0;
  else if (r.bottom > innerHeight - 16) dy = Math.min(r.bottom - innerHeight + 16, r.top - top0);
  if (Math.abs(dy) > 1) window.scrollBy({ top: dy, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function focusFirst() {
  if (!ED?.el.isConnected) return;
  const t = $('.ied-body .ctl:not([type=checkbox]):not([type=radio]):not([disabled])', ED.el)
    || $('.ied-body input, .ied-body button', ED.el) || $('[data-ed-cancel]', ED.el);
  t?.focus({ preventScroll: true });
}

function hideConfirm() {
  if (!ED?.del) return;
  $('.foot-confirm', ED.el).hidden = true;
  $('.foot-main', ED.el).hidden = false;
  $('[data-ed-del]', ED.el)?.focus();
}

function showEdError(err) {
  if (!ED) return;
  const box = $('.ied-error', ED.el);
  const usages = err?.payload?.usages || err?.usages;
  let msg = err?.message || String(err);
  if (usages?.length) msg = msg.split(' — ')[0] + ':';
  box.innerHTML = `<p>${esc(msg)}</p>${usages?.length ? `<ul>${usages.map((u) => (typeof u === 'string'
    ? `<li>${esc(u)}</li>`
    : `<li>${esc(u.org_name)} / ${esc(u.device_name)} / ${esc(u.set_name)} <span>(копия №${u.copy_no})</span></li>`)).join('')}</ul>` : ''}`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}
function hideEdError() { if (ED) $('.ied-error', ED.el).hidden = true; }

function ensureRouteEditor(r) {
  const key = routeEditorKey(r);
  if (!key || ED?.key === key || ED?.dirty) return;
  if (r.page === 'storages') {
    const st = state.idx.st.get(r.stId);
    if (st) storageEditor(st, { routeBound: true });
    else history.replaceState(null, '', '#storages');
  } else if (r.page === 'neworg') {
    orgEditor(null, { routeBound: true });
  }
}

/* ---------------------------------------------------------- поля форм */
function fieldHtml(f, v = '') {
  v = v ?? '';
  const id = `f-${f.key}`;
  const cls = `field${f.wide ? ' wide' : ''}${f.span ? ` span${f.span}` : ''}`;
  const hint = f.hint ? `<small>${esc(f.hint)}</small>` : '';
  if (f.type === 'colors') {
    return `<div class="${cls}" role="radiogroup" aria-labelledby="${id}"><span id="${id}">${esc(f.label)}</span>
      <div class="swatches">
        <label class="swatch auto" title="Автоматически, по тегу"><input type="radio" name="${f.key}" value=""${COLOR_HEX[v] ? '' : ' checked'}>
          <span class="sw" style="--av:${COLOR_HEX[f.auto] || '#475569'}"></span><span class="sw-text">авто</span></label>
        ${ORG_COLORS.map(([k, l, h]) => `<label class="swatch" title="${esc(l)}"><input type="radio" name="${f.key}" value="${k}"${v === k ? ' checked' : ''}>
          <span class="sw" style="--av:${h}"></span><span class="sr-only">${esc(l)}</span></label>`).join('')}
      </div>${hint}</div>`;
  }
  let input;
  if (f.type === 'textarea') {
    input = `<textarea id="${id}" class="ctl${f.mono ? ' mono' : ''}" name="${f.key}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
  } else if (f.type === 'select') {
    const opts = Object.entries(state.meta[f.options]).map(([k, l]) =>
      `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
    input = `<select id="${id}" class="ctl" name="${f.key}">${f.empty !== undefined ? `<option value="">${esc(f.empty)}</option>` : ''}${opts}</select>`;
  } else {
    input = `<input id="${id}" class="ctl${f.mono ? ' mono' : ''}" name="${f.key}" type="text" value="${esc(v)}"
      placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="${f.mono ? 'false' : 'true'}"${f.list ? ` list="${f.list}"` : ''}>`;
  }
  return `<label class="${cls}" for="${id}"><span>${esc(f.label)}${f.required ? ' <b class="req">обязательно</b>' : ''}</span>
    ${input}${hint}</label>`;
}
const fieldsHtml = (specs, values = {}) => specs.map((f) => fieldHtml(f, values[f.key])).join('');

function readForm(form, specs) {
  const out = {};
  for (const f of specs) {
    out[f.key] = (form.elements[f.key]?.value ?? '').trim();
    if (f.required && !out[f.key]) {
      form.elements[f.key]?.focus();
      throw new Error(`Заполните поле «${f.label}».`);
    }
  }
  return out;
}

const ORG_FIELDS = [
  { key: 'name', label: 'Название', required: true, placeholder: 'ООО «Рога и Копыта»' },
  { key: 'tag', label: 'Тег', placeholder: '#RIK', hint: 'Короткий уникальный код организации, его буквы — на аватаре' },
  { key: 'color', label: 'Цвет аватара', type: 'colors', wide: true },
  { key: 'notes', label: 'Заметки', type: 'textarea', wide: true, placeholder: 'Контакты, договор, особенности…' },
];

const DEVICE_FIELDS = [
  { key: 'name', label: 'Имя', required: true, placeholder: 'SRV-1C' },
  { key: 'host', label: 'IP / hostname', placeholder: '192.168.1.10', mono: true },
  { key: 'kind', label: 'Тип', type: 'select', options: 'device_kinds', empty: '—' },
  { key: 'os', label: 'ОС', placeholder: 'Windows Server 2019', list: 'dl-os' },
  { key: 'role', label: 'Роль', placeholder: 'Сервер 1С, файловый сервер…', list: 'dl-roles' },
  { key: 'hypervisor', label: 'Гипервизор / хост', placeholder: 'Hyper-V на HV-01', hint: 'Для виртуальных машин', list: 'dl-hypervisors' },
  { key: 'location', label: 'Расположение', placeholder: 'Офис, серверная', span: 2, list: 'dl-locations' },
  { key: 'notes', label: 'Заметки', type: 'textarea', wide: true },
];

const STORAGE_FIELDS = [
  { key: 'name', label: 'Название', required: true, placeholder: 'NAS-01' },
  { key: 'type', label: 'Тип', type: 'select', options: 'storage_types', empty: '—' },
  { key: 'scope', label: 'Размещение', type: 'select', options: 'storage_scopes',
    hint: 'Удалённое — вне офиса (облако, другая площадка)' },
  { key: 'location', label: 'Где находится', placeholder: 'Серверная офиса / Selectel', list: 'dl-locations' },
  { key: 'address', label: 'Адрес / путь', wide: true, mono: true, placeholder: '\\\\192.168.1.20\\backup  или  s3://bucket/path' },
  { key: 'notes', label: 'Заметки', type: 'textarea', wide: true,
    hint: 'Не храните здесь пароли — укажите, где они лежат (например, «KeePass → Клиенты → NAS-01»)' },
];

const SET_FIELDS = [
  { key: 'name', label: 'Название набора', required: true, placeholder: 'База 1С «Бухгалтерия»' },
  { key: 'type', label: 'Что копируем', type: 'select', options: 'set_types' },
  { key: 'source', label: 'Источник', type: 'textarea', rows: 2, mono: true },
  { key: 'notes', label: 'Заметки', type: 'textarea', rows: 2 },
];

/* --------------------------------------------------------- организация */
function refreshOrgLive() {
  if (!ED?.live) return;
  const card = ED.el.closest('[data-card]');
  if (!card) return;
  const o = { ...(ED.base || {}), ...ED.live };
  for (const el of $$('[data-live]', card)) {
    if (el.dataset.live === 'avatar') el.innerHTML = avatarHtml(o, el.dataset.size || 'l');
    else if (el.dataset.live === 'name') el.textContent = o.name.trim() || (ED.base ? '' : 'Без названия');
    else if (el.dataset.live === 'tag') el.textContent = normTag(o.tag);
  }
}

function orgEditor(org, { routeBound = false } = {}) {
  const nSets = org ? orgSets(org).length : 0;
  const live = { name: org?.name || '', tag: org?.tag || '', color: org?.color || '' };
  const specs = ORG_FIELDS.map((f) => (f.key === 'color' ? { ...f, auto: autoColor(live) } : f));
  const body = document.createElement('div');
  body.innerHTML = `<div class="grid g2">${fieldsHtml(specs, org || {})}</div>`;
  const onLive = (e) => {
    const k = e.target.name;
    if (!(k in live)) return;
    live[k] = e.target.value;
    if (k !== 'color') $('.swatch.auto .sw', body)?.style.setProperty('--av', COLOR_HEX[autoColor(live)]);
    refreshOrgLive();
  };
  body.addEventListener('input', onLive);
  body.addEventListener('change', onLive);
  openEditor({
    key: org ? `org:${org.id}` : 'org:new',
    routeBound,
    title: org ? org.name : 'Новая организация',
    base: org || null,
    live,
    body,
    submitLabel: org ? 'Сохранить' : 'Добавить организацию',
    onSubmit: async (form) => {
      const v = readForm(form, ORG_FIELDS);
      const r = org ? await api('PUT', `/api/orgs/${org.id}`, v) : await api('POST', '/api/orgs', v);
      return r.id;
    },
    onSaved: (id) => {
      toast(org ? 'Организация сохранена' : 'Организация добавлена');
      showOrg(id);
    },
    del: org && {
      label: 'Удалить организацию',
      question: `Удалить «${org.name}» вместе с ${plural(org.devices.length, 'устройством', 'устройствами', 'устройствами')} `
        + `и ${plural(nSets, 'набором', 'наборами', 'наборами')}? Хранилища останутся в общем справочнике.`,
      run: () => api('DELETE', `/api/orgs/${org.id}`),
      done: () => { toast('Организация удалена'); go(''); },
    },
  });
}

/* ---------------------------------------------------------- устройство */
function deviceEditor(orgId, dev) {
  const org = dev ? state.idx.dev.get(dev.id).org : state.idx.org.get(orgId);
  if (!org) return;
  openEditor({
    key: dev ? `dev:${dev.id}` : `dev:new:${org.id}`,
    title: dev ? dev.name : 'Новое устройство',
    body: `<div class="grid g4">${fieldsHtml(DEVICE_FIELDS, dev || {})}</div>`,
    submitLabel: dev ? 'Сохранить' : 'Добавить устройство',
    onSubmit: async (form) => {
      const v = readForm(form, DEVICE_FIELDS);
      const r = dev ? await api('PUT', `/api/devices/${dev.id}`, v) : await api('POST', `/api/orgs/${org.id}/devices`, v);
      return r.id;
    },
    onSaved: (id) => {
      toast(dev ? 'Устройство сохранено' : 'Устройство добавлено');
      state.flash = { key: `dev:${id}`, scroll: 'nearest' };
      showOrg(org.id);
    },
    del: dev && {
      label: 'Удалить устройство',
      question: `Удалить «${dev.name}» вместе с ${plural(dev.sets.length, 'набором', 'наборами', 'наборами')}?`,
      run: () => api('DELETE', `/api/devices/${dev.id}`),
      done: () => { toast('Устройство удалено'); render(); },
    },
  });
}

/* показать организацию: если она уже открыта — просто перерисовать */
function showOrg(orgId) {
  const r = route();
  if (r?.page === 'org' && r.orgId === orgId) render(); else go(`org/${orgId}`);
}

/* --------------------------------------------- набор (с редактором копий) */
/* шапка раскрытого набора повторяет строку плана и меняется на лету */
function refreshSetHead() {
  if (!ED?.live) return;
  const head = $('.set-head', ED.el.closest('[data-card]') || document.createElement('i'));
  if (head) head.outerHTML = setRowHtml({ ...ED.base, ...ED.live }, { open: true });
}

function setEditor(devId, set) {
  const ctx = set ? state.idx.set.get(set.id) : state.idx.dev.get(devId);
  if (!ctx) return;
  const { org, dev } = ctx;
  const blankCopy = (from) => ({ id: newCopyId(), from, storage_id: '', stage: 'active', tool: '', schedule: '', retention: '', notes: '' });
  const defaultType = state.dicts.set_types[0]?.id || '';
  const copies = set ? structuredClone(set.copies) : [blankCopy('source')];
  const live = { name: set?.name || '', type: set?.type || defaultType, source: set?.source || '', copies };

  const body = document.createElement('div');
  body.innerHTML = `<div class="grid g2">${fieldsHtml(SET_FIELDS, set || { type: defaultType })}</div>`;
  const typeSel = $('select[name=type]', body);
  const sourceEl = $('textarea[name=source]', body);
  const updateHint = () => { sourceEl.placeholder = dictItem('set_types', typeSel.value)?.hint || ''; };
  typeSel.addEventListener('change', updateHint);
  updateHint();
  const onLive = (e) => {
    const k = e.target.name;
    if (!['name', 'type', 'source'].includes(k)) return;
    live[k] = e.target.value;
    refreshSetHead();
  };
  body.addEventListener('input', onLive);
  body.addEventListener('change', onLive);
  const ce = copyEditor(org, copies, blankCopy, refreshSetHead);
  body.append(ce);

  openEditor({
    key: set ? `set:${set.id}` : `set:new:${dev.id}`,
    title: set ? set.name : 'Новый набор',
    base: set || { id: '' },
    live,
    body,
    focusCopy: (cid) => ce.focusCopy(cid),
    submitLabel: set ? 'Сохранить' : 'Добавить набор',
    onSubmit: async (form) => {
      const v = readForm(form, SET_FIELDS);
      copies.forEach((c, i) => {
        if (!c.storage_id) {
          $(`[data-i="${i}"] [data-k=storage_id]`, form)?.focus();
          throw new Error(`Копия №${i + 1}: выберите хранилище.`);
        }
      });
      v.copies = copies.map(({ _ns, _ed, ...c }) => {
        for (const f of ['schedule', 'retention']) {
          const k = `${f}_spec`;
          if (!c[f] || !c[k] || c[k].kind === 'custom') delete c[k];
        }
        return c;
      });
      const r = set ? await api('PUT', `/api/sets/${set.id}`, v) : await api('POST', `/api/devices/${dev.id}/sets`, v);
      return r.id;
    },
    onSaved: (id) => {
      toast(set ? 'Набор сохранён' : 'Набор добавлен');
      state.flash = { key: `set:${id}`, scroll: 'nearest' };
      showOrg(org.id);
    },
    del: set && {
      label: 'Удалить набор',
      question: `Удалить набор «${set.name}» и описание его копий?`,
      run: () => api('DELETE', `/api/sets/${set.id}`),
      done: () => { toast('Набор удалён'); render(); },
    },
  });
}

/* ---------------------------------------------- расписание и хранение
   В копии хранится текст (schedule / retention) — его видно в плане, и структура
   (schedule_spec / retention_spec) для редактора. Текст без структуры разбирается
   при открытии редактора; если не получилось — это «свой текст».             */
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const DAYSETS = { all: ALL_DAYS, work: [1, 2, 3, 4, 5], weekend: [6, 7] };
const toInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.min(max, Math.max(min, n)) : def;
};
const padTime = (t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t);
const listJoin = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} и ${a[a.length - 1]}`);
const normDays = (days) => [...new Set((days || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);

function daysText(days, plain = false) {
  const d = normDays(days);
  const key = d.join('');
  if (!d.length || key === '1234567') return 'ежедневно';
  if (key === '12345') return 'по будням';
  if (key === '67') return 'по выходным';
  if (d.length === 1) return plain ? WD[d[0] - 1] : `еженедельно, ${WD[d[0] - 1]}`;
  const parts = [];
  for (let i = 0; i < d.length;) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    if (j - i >= 2) parts.push(`${WD[d[i] - 1]}–${WD[d[j] - 1]}`);
    else for (let k = i; k <= j; k++) parts.push(WD[d[k] - 1]);
    i = j + 1;
  }
  return parts.join(', ');
}
const timesOf = (times) => [...new Set((times || []).filter((t) => /^\d\d:\d\d$/.test(t)))].sort();

const SCHED = {
  title: 'Расписание',
  kinds: [['days', 'По дням'], ['interval', 'Интервал'], ['monthly', 'Ежемесячно'], ['continuous', 'Непрерывно'],
    ['after', 'После предыдущего'], ['manual', 'Вручную'], ['custom', 'Свой текст']],
  make: {
    days: (prev) => ({ kind: 'days', days: prev?.days ? normDays(prev.days) : [...ALL_DAYS], times: ['23:00'] }),
    interval: (prev) => ({ kind: 'interval', every: 1, unit: 'hour', days: prev?.days ? normDays(prev.days) : [...ALL_DAYS], from: '', to: '' }),
    monthly: () => ({ kind: 'monthly', day: 1, time: '02:00' }),
    continuous: () => ({ kind: 'continuous' }),
    after: () => ({ kind: 'after' }),
    manual: () => ({ kind: 'manual' }),
  },
  text(s) {
    switch (s.kind) {
      case 'days': {
        const t = timesOf(s.times);
        return [daysText(s.days), t.length ? `в ${listJoin(t)}` : ''].filter(Boolean).join(' ');
      }
      case 'interval': {
        const n = toInt(s.every, 1, 999, 1);
        const min = s.unit === 'min';
        const one = n % 10 === 1 && n % 100 !== 11;
        const every = n === 1 ? (min ? 'каждую минуту' : 'каждый час')
          : `${one ? (min ? 'каждую' : 'каждый') : 'каждые'} ${plural(n, ...(min ? ['минуту', 'минуты', 'минут'] : ['час', 'часа', 'часов']))}`;
        const win = s.from && s.to ? ` с ${s.from} до ${s.to}` : '';
        const d = normDays(s.days);
        return (d.length && d.length < 7 ? `${daysText(d, true)}: ` : '') + every + win;
      }
      case 'monthly': {
        const day = toInt(s.day, 0, 31, 1);
        return `ежемесячно, ${day ? `${day}-го числа` : 'в последний день'}${s.time ? ` в ${s.time}` : ''}`;
      }
      case 'continuous': return 'непрерывно (синхронизация)';
      case 'after': return 'сразу после предыдущего шага';
      case 'manual': return 'вручную';
      default: return '';
    }
  },
  parse(text) {
    const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t) return null;
    const exact = { 'вручную': 'manual', 'непрерывно': 'continuous', 'непрерывно (синхронизация)': 'continuous', 'сразу после предыдущего шага': 'after' };
    if (exact[t]) return { kind: exact[t] };
    const times = (str) => {
      if (!str) return [];
      const arr = str.replace(/^в /, '').split(/\s*(?:,|\sи\s)\s*/);
      return arr.every((x) => /^\d{1,2}:\d\d$/.test(x)) ? arr.map(padTime) : null;
    };
    const DWR = '(?:пн|вт|ср|чт|пт|сб|вс)';
    let m = t.match(/^(ежедневно|каждый день|по будням|по выходным)(?:,? (.+))?$/);
    if (m) {
      const tm = times(m[2]);
      const set = { 'ежедневно': 'all', 'каждый день': 'all', 'по будням': 'work', 'по выходным': 'weekend' }[m[1]];
      if (tm) return { kind: 'days', days: [...DAYSETS[set]], times: tm };
    }
    m = t.match(new RegExp(`^(?:еженедельно,? )?(${DWR}(?:, ?${DWR})*),? (.+)$`));
    if (m) {
      const tm = times(m[2]);
      if (tm) return { kind: 'days', days: normDays(m[1].split(/, ?/).map((d) => WD.indexOf(d) + 1)), times: tm };
    }
    m = t.match(/^кажд(?:ый|ые|ую) (?:(\d+) )?(час|часа|часов|минуту|минуты|минут)$/);
    if (m) return { kind: 'interval', every: Number(m[1] || 1), unit: m[2].startsWith('мин') ? 'min' : 'hour', days: [...ALL_DAYS], from: '', to: '' };
    return null;
  },
};

const RET_UNITS = {
  day: ['день', 'дня', 'дней'], week: ['неделя', 'недели', 'недель'],
  month: ['месяц', 'месяца', 'месяцев'], year: ['год', 'года', 'лет'],
  copies: ['копия', 'копии', 'копий'], versions: ['версия', 'версии', 'версий'],
};
const GFS = [['d', 'ежедневных', 'дн.'], ['w', 'еженедельных', 'нед.'], ['m', 'ежемесячных', 'мес.'], ['y', 'ежегодных', 'г.']];

const RETN = {
  title: 'Хранение',
  kinds: [['period', 'Срок'], ['count', 'Количество'], ['gfs', 'GFS'], ['last', 'Последняя версия'],
    ['forever', 'Бессрочно'], ['custom', 'Свой текст']],
  make: {
    period: () => ({ kind: 'period', n: 14, unit: 'day' }),
    count: () => ({ kind: 'count', n: 7, unit: 'copies' }),
    gfs: () => ({ kind: 'gfs', d: 7, w: 4, m: 12, y: 0 }),
    last: () => ({ kind: 'last' }),
    forever: () => ({ kind: 'forever' }),
  },
  text(r) {
    switch (r.kind) {
      case 'period': case 'count': {
        const units = RET_UNITS[r.unit] || RET_UNITS[r.kind === 'period' ? 'day' : 'copies'];
        return plural(toInt(r.n, 1, 9999, 1), ...units);
      }
      case 'gfs': {
        const parts = GFS.map(([k, , short]) => [toInt(r[k], 0, 999, 0), short]).filter(([n]) => n).map(([n, s]) => `${n} ${s}`);
        return parts.length ? `GFS: ${parts.join(' + ')}` : '';
      }
      case 'last': return 'только последняя версия';
      case 'forever': return 'бессрочно';
      default: return '';
    }
  },
  parse(text) {
    const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t) return null;
    if (t === 'бессрочно') return { kind: 'forever' };
    if (t === 'только последняя версия' || t === 'последняя версия') return { kind: 'last' };
    const m = t.match(/^(\d+) (\S+)$/);
    if (m) {
      const unit = Object.keys(RET_UNITS).find((u) => RET_UNITS[u].includes(m[2]));
      if (unit) return { kind: ['copies', 'versions'].includes(unit) ? 'count' : 'period', n: Number(m[1]), unit };
    }
    const g = t.match(/^gfs: (.+)$/);
    if (g) {
      const spec = { kind: 'gfs', d: 0, w: 0, m: 0, y: 0 };
      const ok = g[1].split(' + ').every((p) => {
        const pm = p.match(/^(\d+) (дн\.|нед\.|мес\.|г\.)$/);
        if (!pm) return false;
        spec[GFS.find(([, , s]) => s === pm[2])[0]] = Number(pm[1]);
        return true;
      });
      if (ok) return spec;
    }
    return null;
  },
};
const EDITORS = { schedule: SCHED, retention: RETN };

/* открыть редактор поля: структура из копии, иначе разбор текста, иначе «свой текст» */
function ensureSpec(c, f) {
  const k = `${f}_spec`;
  if (c[k]?.kind) return;
  c[k] = EDITORS[f].parse(c[f]) || (c[f] ? { kind: 'custom' } : null);
}

function wdHtml(days) {
  const d = new Set(normDays(days));
  return `<div class="wd" role="group" aria-label="Дни недели">${WD.map((w, i) =>
    `<button type="button" class="wd-btn" aria-pressed="${d.has(i + 1)}" data-ed-wd="${i + 1}">${w}</button>`).join('')}</div>
    <span class="ed-quick">${[['all', 'все'], ['work', 'будни'], ['weekend', 'выходные']].map(([k, l]) =>
      `<button type="button" class="link-btn" data-ed-wdset="${k}">${l}</button>`).join('')}</span>`;
}
const numHtml = (f, v, min, max, lbl, cls = '') => `<input type="number" class="ctl ctl-s ed-num ${cls}" data-ed-f="${f}" value="${esc(v)}"
  min="${min}" max="${max}" step="1" inputmode="numeric" aria-label="${esc(lbl)}">`;
const selHtml = (f, v, opts, lbl) => `<select class="ctl ctl-s ed-sel" data-ed-f="${f}" aria-label="${esc(lbl)}">${opts.map(([k, l]) =>
  `<option value="${esc(k)}"${String(k) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const timeHtml = (attr, v, lbl) => `<input type="time" class="ctl ctl-s ed-time" ${attr} value="${esc(v || '')}" aria-label="${esc(lbl)}">`;

function edBodyHtml(f, c) {
  const s = c[`${f}_spec`];
  if (!s) return '<p class="ed-note">Выберите вариант выше.</p>';
  if (s.kind === 'custom') {
    return `<input class="ctl ctl-s" data-ed-text value="${esc(c[f])}" autocomplete="off" aria-label="${EDITORS[f].title}: свой текст"
      placeholder="${f === 'schedule' ? 'например: по рабочим дням каждые 2 часа' : 'например: 30 дней, но не меньше 10 копий'}">`;
  }
  const line = (lbl, inner) => `<div class="ed-line"><span class="ed-label">${lbl}</span><div class="ed-ctl">${inner}</div></div>`;
  switch (s.kind) {
    case 'days': {
      const times = s.times?.length ? s.times : [''];
      return line('Дни', wdHtml(s.days)) + line('Время', `${times.map((t, i) => `<span class="ed-time-wrap">${
        timeHtml(`data-ed-time="${i}"`, t, `Время запуска ${i + 1}`)}${times.length > 1
        ? `<button type="button" class="icon-btn" data-ed-time-del="${i}" aria-label="Убрать время ${esc(t)}" title="Убрать">×</button>` : ''}</span>`).join('')}
        <button type="button" class="btn btn-s btn-ghost" data-ed-time-add>+ время</button>`);
    }
    case 'interval':
      return line('Каждые', `${numHtml('every', s.every, 1, 999, 'Интервал')}
          ${selHtml('unit', s.unit, [['min', 'минут'], ['hour', 'часов']], 'Единица интервала')}`)
        + line('Окно', `<span class="ed-word">с</span>${timeHtml('data-ed-f="from"', s.from, 'Начало окна')}
          <span class="ed-word">до</span>${timeHtml('data-ed-f="to"', s.to, 'Конец окна')}<span class="ed-opt">необязательно</span>`)
        + line('Дни', wdHtml(s.days));
    case 'monthly':
      return line('Число', selHtml('day', toInt(s.day, 0, 31, 1),
        [...Array.from({ length: 31 }, (_, i) => [i + 1, `${i + 1}-го`]), [0, 'последний день']], 'Число месяца'))
        + line('Время', timeHtml('data-ed-f="time"', s.time, 'Время запуска'));
    case 'continuous': return '<p class="ed-note">Синхронизация или репликация в реальном времени: клиент облака, DFS, репликация ВМ.</p>';
    case 'after': return '<p class="ed-note">Запускается, когда закончился предыдущий шаг: например, выгрузка 1С, затем копирование на NAS, затем в облако.</p>';
    case 'manual': return '<p class="ed-note">Копию делают вручную, по необходимости. Опишите порядок в заметках.</p>';
    case 'period':
      return line('Хранить', `${numHtml('n', s.n, 1, 9999, 'Срок хранения')}
        ${selHtml('unit', s.unit, [['day', 'дней'], ['week', 'недель'], ['month', 'месяцев'], ['year', 'лет']], 'Единица срока')}`);
    case 'count':
      return line('Хранить', `<span class="ed-word">последние</span>${numHtml('n', s.n, 1, 9999, 'Сколько хранить')}
        ${selHtml('unit', s.unit, [['copies', 'копий'], ['versions', 'версий']], 'Что считать')}`);
    case 'gfs':
      return `<div class="ed-gfs">${GFS.map(([k, l]) => `<label class="cr-field"><span>${l}</span>${numHtml(k, s[k] ?? 0, 0, 999, `Сколько ${l} копий`)}</label>`).join('')}</div>
        <p class="ed-note">Дед-отец-сын: сколько ежедневных, еженедельных, ежемесячных и ежегодных копий держать. 0 — не хранить.</p>`;
    case 'last': return '<p class="ed-note">Хранится только последняя версия (зеркало): удалённое в источнике пропадёт и из копии.</p>';
    case 'forever': return '<p class="ed-note">Копии не удаляются автоматически.</p>';
    default: return '';
  }
}

function editorHtml(f, c, n) {
  const ed = EDITORS[f];
  const kind = c[`${f}_spec`]?.kind;
  return `<div class="cr-ed" data-ed="${f}" role="group" aria-label="${ed.title} копии №${n}">
    <div class="ed-kinds" role="radiogroup" aria-label="${ed.title}: вариант">${ed.kinds.map(([k, l]) =>
      `<button type="button" class="ed-kind" role="radio" aria-checked="${kind === k}" data-ed-kind="${k}">${l}</button>`).join('')}</div>
    <div class="ed-body">${edBodyHtml(f, c)}</div>
    <div class="ed-foot">
      <span class="ed-result" aria-live="polite">${c[f] ? esc(c[f]) : '<span class="muted">не указано</span>'}</span>
      <button type="button" class="btn btn-s btn-ghost" data-ed-clear${c[f] ? '' : ' hidden'}>Очистить</button>
      <button type="button" class="btn btn-s" data-ed-close>Готово</button>
    </div></div>`;
}

function pickerHtml(f, c, n) {
  const open = c._ed === f;
  return `<div class="cr-field cr-${f}"><span id="pk-${f}-${n}">${EDITORS[f].title}</span>
    <button type="button" class="ctl ctl-s picker${open ? ' open' : ''}" data-pick="${f}" aria-expanded="${open}"
      aria-labelledby="pk-${f}-${n} pkv-${f}-${n}"><span class="picker-text${c[f] ? '' : ' empty'}" id="pkv-${f}-${n}">${
      c[f] ? esc(c[f]) : 'не указано'}</span></button></div>`;
}

function copyEditor(org, copies, blankCopy, onChange) {
  const wrap = document.createElement('section');
  wrap.className = 'd-section copies-sec';
  wrap.innerHTML = `
    <h3>Куда копируется</h3>
    <p class="hint">Каждая копия — отдельное место хранения со своим расписанием и сроком хранения.
      Копия может сниматься с источника или с другой копии (например, локальная → облако). Цепочка в шапке меняется сразу.</p>
    <div class="copies-note"></div>
    <ol class="copy-rows"></ol>
    <button type="button" class="btn btn-s" data-add-copy>+ Копия</button>`;
  const rowsEl = $('.copy-rows', wrap);
  const noteEl = $('.copies-note', wrap);
  const stName = (id) => state.idx.st.get(id)?.name || '';
  const changed = () => onChange?.();

  const descendants = (id) => {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of copies) if (!out.has(c.id) && out.has(c.from)) { out.add(c.id); grew = true; }
    }
    return out;
  };

  const newStHtml = (ns) => `<div class="cr-newst" role="group" aria-label="Новое хранилище">
      <p class="cr-newst-title">Хранилище появится в общем справочнике и сразу станет доступно «${esc(org.name)}».</p>
      <div class="cr-newst-grid">
        <label class="cr-field"><span>Название</span><input class="ctl ctl-s" data-ns="name" value="${esc(ns.name)}" placeholder="NAS-01" autocomplete="off"></label>
        <label class="cr-field"><span>Тип</span><select class="ctl ctl-s" data-ns="type"><option value="">—</option>${
          Object.entries(state.meta.storage_types).map(([k, l]) => `<option value="${esc(k)}"${k === ns.type ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="cr-field"><span>Размещение</span><select class="ctl ctl-s" data-ns="scope">${
          Object.entries(state.meta.storage_scopes).map(([k, l]) => `<option value="${esc(k)}"${k === ns.scope ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="cr-field span3"><span>Адрес / путь</span><input class="ctl ctl-s mono" data-ns="address" value="${esc(ns.address)}"
          placeholder="\\\\192.168.1.20\\backup  или  s3://bucket/path" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="cr-newst-err" role="alert" hidden></p>
      <div class="cr-newst-actions">
        <button type="button" class="btn btn-s btn-ghost" data-ns-cancel>Отмена</button>
        <button type="button" class="btn btn-s btn-primary" data-ns-create>Создать и выбрать</button>
      </div></div>`;

  const rowHtml = (c, i) => {
    const avail = orgStorages(org.id);
    const blocked = descendants(c.id);
    const fromOpts = `<option value="source">из источника</option>` + copies.map((o, j) => (blocked.has(o.id) ? ''
      : `<option value="${esc(o.id)}"${o.id === c.from ? ' selected' : ''}>из копии №${j + 1}${o.storage_id ? ` · ${esc(stName(o.storage_id))}` : ''}</option>`)).join('');
    let stOpts = `<option value="">выберите хранилище</option>` + avail.map((s) =>
      `<option value="${esc(s.id)}"${s.id === c.storage_id ? ' selected' : ''}>${esc(s.name)} · ${SCOPE_TEXT[scopeOf(s)]}</option>`).join('');
    if (c.storage_id && !avail.some((s) => s.id === c.storage_id)) {
      stOpts += `<option value="${esc(c.storage_id)}" selected>${esc(stName(c.storage_id) || 'удалённое из справочника')} (нет доступа)</option>`;
    }
    const st = state.idx.st.get(c.storage_id);
    const n = i + 1;
    return `<li class="copy-row" data-i="${i}" data-cid="${esc(c.id)}">
      <div class="cr-top">
        <span class="cr-no ${st ? scopeOf(st) : 'none'}" aria-hidden="true">${st ? icon(stIcon(st), 14) : ''}${n}</span>
        <select class="ctl ctl-s cr-from" data-k="from" aria-label="Копия №${n}: откуда">${fromOpts}</select>
        <span class="cr-arrow" aria-hidden="true">→</span>
        <select class="ctl ctl-s cr-st" data-k="storage_id" aria-label="Копия №${n}: хранилище">${stOpts}</select>
        <button type="button" class="btn btn-s" data-new-st aria-expanded="${c._ns ? 'true' : 'false'}" title="Создать хранилище для этой организации">+ новое</button>
        <button type="button" class="icon-btn" data-del-copy aria-label="Удалить копию №${n}" title="Удалить копию">×</button>
      </div>
      ${c._ns ? newStHtml(c._ns) : ''}
      <div class="cr-fields">
        <label class="cr-field"><span>Инструмент</span><input class="ctl ctl-s" data-k="tool" list="dl-tools" value="${esc(c.tool)}" placeholder="robocopy, Veeam…" autocomplete="off"></label>
        ${pickerHtml('schedule', c, n)}
        ${pickerHtml('retention', c, n)}
        ${c._ed ? `<div class="cr-field wide">${editorHtml(c._ed, c, n)}</div>` : ''}
        <label class="cr-field"><span>Статус</span><select class="ctl ctl-s cr-stage" data-k="stage">${
          Object.entries(state.meta.copy_stages).map(([k, l]) => `<option value="${esc(k)}"${k === stageOf(c) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="cr-field cr-notes"><span>Заметки</span><input class="ctl ctl-s" data-k="notes" value="${esc(c.notes)}" autocomplete="off"></label>
      </div></li>`;
  };

  const renderRows = (focus) => {
    rowsEl.innerHTML = copies.map(rowHtml).join('');
    noteEl.innerHTML = orgStorages(org.id).length ? ''
      : `<p class="note">У «${esc(org.name)}» ещё нет доступных хранилищ — создайте первое кнопкой «+ новое».</p>`;
    changed();
    if (focus) $(`[data-i="${focus.i}"] ${focus.sel}`, rowsEl)?.focus();
  };
  renderRows();

  /* редактор расписания / хранения: ввод в поля без перерисовки (чтобы не терять фокус) */
  const NUM_F = ['every', 'n', 'd', 'w', 'm', 'y', 'day'];
  const showEdText = (row, f, c) => {
    const n = +row.dataset.i + 1;
    const pv = $(`#pkv-${f}-${n}`, row);
    if (pv) { pv.textContent = c[f] || 'не указано'; pv.classList.toggle('empty', !c[f]); }
    const res = $('.ed-result', row);
    if (res) res.innerHTML = c[f] ? esc(c[f]) : '<span class="muted">не указано</span>';
    const clr = $('[data-ed-clear]', row);
    if (clr) clr.hidden = !c[f];
  };
  const onEdInput = (t, c, f, row) => {
    const k = `${f}_spec`;
    const spec = c[k];
    if (t.hasAttribute('data-ed-text')) c[f] = t.value;
    else if (spec && t.dataset.edF) spec[t.dataset.edF] = NUM_F.includes(t.dataset.edF) && t.value !== '' ? Number(t.value) : t.value;
    else if (spec && t.dataset.edTime !== undefined) (spec.times ||= [])[+t.dataset.edTime] = t.value;
    else return;
    if (spec && spec.kind !== 'custom') c[f] = EDITORS[f].text(spec);
    showEdText(row, f, c);
    changed();
  };
  const onEdClick = (b, c, f, i) => {
    const k = `${f}_spec`;
    const ed = EDITORS[f];
    const s = c[k];
    let focus;
    if (b.dataset.edKind) {
      const kind = b.dataset.edKind;
      if (s?.kind !== kind) c[k] = kind === 'custom' ? { kind } : ed.make[kind](s);
      focus = `[data-ed-kind="${kind}"]`;
    } else if (b.dataset.edWd) {
      const d = +b.dataset.edWd;
      const days = new Set(normDays(s.days));
      if (!days.has(d)) days.add(d); else if (days.size > 1) days.delete(d);
      s.days = normDays([...days]);
      focus = `[data-ed-wd="${d}"]`;
    } else if (b.dataset.edWdset) {
      s.days = [...DAYSETS[b.dataset.edWdset]];
      focus = `[data-ed-wdset="${b.dataset.edWdset}"]`;
    } else if (b.hasAttribute('data-ed-time-add')) {
      const have = timesOf(s.times);
      s.times = [...have, ['12:00', '18:00', '06:00', '09:00', '15:00', '21:00'].find((t) => !have.includes(t)) || ''];
      focus = `[data-ed-time="${s.times.length - 1}"]`;
    } else if (b.dataset.edTimeDel !== undefined) {
      s.times.splice(+b.dataset.edTimeDel, 1);
      focus = '[data-ed-time-add]';
    } else if (b.hasAttribute('data-ed-clear')) {
      c[f] = '';
      c[k] = null;
      focus = '.ed-kind';
    } else if (b.hasAttribute('data-ed-close')) {
      delete c._ed;
      renderRows({ i, sel: `[data-pick="${f}"]` });
      return;
    } else {
      return;
    }
    if (c[k] && c[k].kind !== 'custom') c[f] = ed.text(c[k]);
    renderRows({ i, sel: `[data-ed="${f}"] ${focus}` });
    if (ED) ED.dirty = true;
  };

  const onField = (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const c = copies[+row.dataset.i];
    if (!c) return;
    const edEl = e.target.closest('.cr-ed');
    if (edEl) {
      onEdInput(e.target, c, edEl.dataset.ed, row);
    } else if (e.target.dataset.k) {
      const k = e.target.dataset.k;
      if (c[k] === e.target.value) return;
      c[k] = e.target.value;
      if (e.target.tagName === 'SELECT') renderRows({ i: row.dataset.i, sel: `[data-k="${k}"]` });
      else changed();
    } else if (e.target.dataset.ns && c._ns) {
      c._ns[e.target.dataset.ns] = e.target.value;
    }
  };
  rowsEl.addEventListener('input', onField);
  rowsEl.addEventListener('change', onField);

  const createStorage = async (i) => {
    const c = copies[i];
    const row = $(`[data-i="${i}"]`, rowsEl);
    const err = $('.cr-newst-err', row);
    const ns = c._ns;
    if (!ns.name.trim()) {
      err.textContent = 'Укажите название хранилища.';
      err.hidden = false;
      $('[data-ns=name]', row).focus();
      return;
    }
    const btn = $('[data-ns-create]', row);
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/orgs/${org.id}/storages`,
        { name: ns.name, type: ns.type, scope: ns.scope, address: ns.address, location: '', notes: '' });
      c.storage_id = r.id;
      delete c._ns;
      renderRows({ i, sel: '[data-k="tool"]' });
      render();
      toast(`Хранилище «${ns.name.trim()}» создано и выбрано в копии №${i + 1}`);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };

  rowsEl.addEventListener('keydown', (e) => {
    const edEl = e.target.closest('.cr-ed');
    if (edEl && (e.key === 'Escape' || (e.key === 'Enter' && e.target.tagName === 'INPUT'))) {
      // Esc и Enter закрывают редактор поля, а не всю форму / не отправляют её
      e.preventDefault();
      e.stopPropagation();
      const i = +edEl.closest('[data-i]').dataset.i;
      delete copies[i]._ed;
      renderRows({ i, sel: `[data-pick="${edEl.dataset.ed}"]` });
      return;
    }
    if (e.key === 'Enter' && e.target.dataset.ns) {
      e.preventDefault();
      createStorage(+e.target.closest('[data-i]').dataset.i);
    }
  });
  rowsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const row = b?.closest('[data-i]');
    if (!row) return;
    const i = +row.dataset.i;
    const c = copies[i];
    if (b.dataset.pick) {
      const f = b.dataset.pick;
      if (c._ed === f) {
        delete c._ed;
        renderRows({ i, sel: `[data-pick="${f}"]` });
      } else {
        c._ed = f;
        ensureSpec(c, f);
        renderRows();
        const ed = $(`[data-i="${i}"] [data-ed]`, rowsEl);
        ($('.ed-kind[aria-checked="true"]', ed) || $('.ed-kind', ed))?.focus();
      }
      return;
    }
    const edEl = b.closest('.cr-ed');
    if (edEl) { onEdClick(b, c, edEl.dataset.ed, i); return; }
    if (b.hasAttribute('data-del-copy')) {
      const [removed] = copies.splice(i, 1);
      copies.forEach((x) => { if (x.from === removed.id) x.from = removed.from; });
      renderRows();
      if (ED) ED.dirty = true;
    } else if (b.hasAttribute('data-new-st')) {
      copies[i]._ns = copies[i]._ns ? undefined : { name: '', type: '', scope: 'local', address: '' };
      if (!copies[i]._ns) delete copies[i]._ns;
      renderRows(copies[i]._ns ? { i, sel: '[data-ns=name]' } : { i, sel: '[data-new-st]' });
    } else if (b.hasAttribute('data-ns-cancel')) {
      delete copies[i]._ns;
      renderRows({ i, sel: '[data-new-st]' });
    } else if (b.hasAttribute('data-ns-create')) {
      createStorage(i);
    }
  });
  $('[data-add-copy]', wrap).addEventListener('click', () => {
    copies.push(blankCopy(copies.length ? copies[copies.length - 1].id : 'source'));
    renderRows({ i: copies.length - 1, sel: '[data-k="storage_id"]' });
    if (ED) ED.dirty = true;
  });

  /* клик по пилюле в шапке — к строке этой копии */
  wrap.focusCopy = (cid) => {
    const i = copies.findIndex((c) => c.id === cid);
    const row = i >= 0 && $(`[data-i="${i}"]`, rowsEl);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    $('[data-k=storage_id]', row)?.focus({ preventScroll: true });
    row.classList.remove('hl');
    void row.offsetWidth;
    row.classList.add('hl');
    row.addEventListener('animationend', () => row.classList.remove('hl'), { once: true });
  };
  return wrap;
}

/* ----------------------------------------------------------- хранилище */
function usageHtml(st) {
  const usages = storageUsages(st.id);
  if (!usages.length) return '<p class="muted" style="margin:0">Пока пусто: ни одна копия не использует это хранилище.</p>';
  const byOrg = new Map();
  for (const u of usages) {
    if (!byOrg.has(u.org.id)) byOrg.set(u.org.id, { org: u.org, devs: new Map() });
    const o = byOrg.get(u.org.id);
    if (!o.devs.has(u.dev.id)) o.devs.set(u.dev.id, { dev: u.dev, items: [] });
    o.devs.get(u.dev.id).items.push(u);
  }
  return `<ul class="usage">${[...byOrg.values()].map(({ org, devs }) => `<li>
    <a class="usage-org" href="#org/${esc(org.id)}">${avatarHtml(org, 'xs')}${esc(org.name)}</a>
    <ul>${[...devs.values()].map(({ dev, items }) => `<li><span class="usage-dev">${icon(typeIcon('device_kinds', dev.kind), 13)}${esc(dev.name)}</span>
      <ul>${items.map((u) => `<li class="usage-set"><a href="#org/${esc(org.id)}/set/${esc(u.set.id)}">${esc(u.set.name)}</a>
        <span>копия №${u.no}${isActive(u.copy) ? '' : ` (${STAGE_SHORT[stageOf(u.copy)]})`}${u.copy.schedule ? `, ${esc(u.copy.schedule)}` : ''}${u.copy.retention ? `, хранить: ${esc(u.copy.retention)}` : ''}</span></li>`).join('')}</ul></li>`).join('')}</ul>
  </li>`).join('')}</ul>`;
}

function storageEditor(st, { orgId = null, routeBound = false } = {}) {
  const forOrg = !st && orgId ? state.idx.org.get(orgId) : null;
  const fields = `<section class="d-section">${st ? '<h3>Описание</h3>' : ''}
    <div class="grid g2">${fieldsHtml(STORAGE_FIELDS, st || { scope: 'local' })}</div></section>`;
  let body;
  if (forOrg) {
    body = `<p class="note">Хранилище попадёт в общий справочник и сразу станет доступно «${esc(forOrg.name)}».
      Доступ другим организациям можно дать позже в разделе «Хранилища».</p>${fields}`;
  } else {
    const checked = new Set(st?.org_ids || []);
    const orgs = [...state.data.organizations].sort(byName);
    const access = `<section class="d-section"><h3>Доступно организациям</h3>
      <p class="hint">Выбрать хранилище в копии могут только отмеченные организации.</p>
      ${orgs.length ? `<div class="checks">${orgs.map((o) => `<label class="check">
        <input type="checkbox" name="org_ids" value="${esc(o.id)}"${checked.has(o.id) ? ' checked' : ''}>
        ${avatarHtml(o, 'xs')}<span class="check-text">${esc(o.name)}</span><span class="tag">${esc(o.tag)}</span></label>`).join('')}</div>`
        : '<p class="muted">Организаций пока нет.</p>'}</section>`;
    const usedCount = st ? storageUsages(st.id).length : 0;
    const usage = st ? `<section class="d-section"><h3>Что здесь лежит</h3>
      <p class="hint">${usedCount ? plural(usedCount, 'копия', 'копии', 'копий') : 'Копий нет'}</p>${usageHtml(st)}</section>` : '';
    body = `<div class="ed-cols"><div>${fields}</div><div>${access}${usage}</div></div>`;
  }

  return openEditor({
    key: st ? `st:${st.id}` : (forOrg ? `st:new:${forOrg.id}` : 'st:new'),
    routeBound,
    title: st ? st.name : 'Новое хранилище',
    body,
    submitLabel: st ? 'Сохранить' : 'Создать хранилище',
    onSubmit: async (form) => {
      const v = readForm(form, STORAGE_FIELDS);
      let r;
      if (forOrg) {
        r = await api('POST', `/api/orgs/${forOrg.id}/storages`, v);
      } else {
        v.org_ids = $$('input[name=org_ids]:checked', form).map((i) => i.value);
        // снять доступ нельзя, пока организация держит на хранилище копии (сервер ответит 409)
        const blocked = st ? st.org_ids.filter((id) => !v.org_ids.includes(id))
          .flatMap((id) => storageUsages(st.id, id)) : [];
        if (blocked.length) {
          throw {
            message: `Нельзя снять доступ: хранилище используется в ${plural(blocked.length, 'копии', 'копиях', 'копиях')} — `,
            usages: blocked.map((u) => ({ org_name: u.org.name, device_name: u.dev.name, set_name: u.set.name, copy_no: u.no })),
          };
        }
        r = st ? await api('PUT', `/api/storages/${st.id}`, v) : await api('POST', '/api/storages', v);
      }
      return r.id;
    },
    onSaved: (id) => {
      toast(st ? 'Хранилище сохранено' : 'Хранилище создано');
      if (route()?.page === 'storages') state.flash = { key: `st:${id}`, scroll: 'nearest' };
      render();
    },
    del: st && {
      label: 'Удалить хранилище',
      question: `Удалить «${st.name}» из справочника?`,
      blocked: () => {
        const used = storageUsages(st.id);
        if (!used.length) return null;
        return {
          message: `Нельзя удалить: хранилище используется в ${plural(used.length, 'копии', 'копиях', 'копиях')}. `
            + 'Сначала уберите его из этих наборов — ',
          usages: used.map((u) => ({ org_name: u.org.name, device_name: u.dev.name, set_name: u.set.name, copy_no: u.no })),
        };
      },
      run: () => api('DELETE', `/api/storages/${st.id}`),
      done: () => { toast('Хранилище удалено'); render(); },
    },
  });
}

function attachEditor(orgId) {
  const org = state.idx.org.get(orgId);
  const list = state.data.storages.filter((s) => !s.org_ids.includes(orgId)).sort(byName);
  if (!list.length) {
    toast('Все хранилища из справочника уже доступны этой организации. Новое можно создать кнопкой «+ Создать».');
    return;
  }
  openEditor({
    key: `attach:${orgId}`,
    title: 'Подключить хранилища',
    body: `<p class="hint">Отмеченные хранилища станут доступны «${esc(org.name)}» и появятся в выборе хранилища у копий.</p>
      <div class="checks">${list.map((s) => `<label class="check">
        <input type="checkbox" name="st" value="${esc(s.id)}">
        <span class="st-ico ${scopeOf(s)}">${icon(stIcon(s), 16)}</span>
        <span class="check-text"><b>${esc(s.name)}</b>
          <span class="check-sub">${esc(label('storage_types', s.type))}${s.address ? ` · <code>${esc(s.address)}</code>` : ''}</span></span>
        <span class="scope-badge ${scopeOf(s)}">${ICON[scopeOf(s)]}${SCOPE_TEXT[scopeOf(s)]}</span></label>`).join('')}</div>`,
    submitLabel: 'Подключить',
    onSubmit: async (form) => {
      const ids = $$('input[name=st]:checked', form).map((i) => i.value);
      if (!ids.length) throw new Error('Отметьте хотя бы одно хранилище.');
      for (const id of ids) await api('PUT', `/api/orgs/${orgId}/storages/${id}`);
      return ids.length;
    },
    onSaved: (n) => { toast(`Подключено: ${plural(n, 'хранилище', 'хранилища', 'хранилищ')}`); render(); },
  });
}

async function detachStorage(orgId, stId) {
  const st = state.idx.st.get(stId);
  const org = state.idx.org.get(orgId);
  if (!st || !org) return;
  const used = storageUsages(stId, orgId);
  if (used.length) {
    toast(`«${st.name}» нельзя отключить: на нём ${plural(used.length, 'копия', 'копии', 'копий')} этой организации. Сначала уберите его из наборов.`, 'error');
    return;
  }
  try {
    await api('DELETE', `/api/orgs/${orgId}/storages/${stId}`);
    render();
    toast(`«${st.name}» отключено от «${org.name}»`, '', {
      label: 'Вернуть',
      fn: async () => {
        try { await api('PUT', `/api/orgs/${orgId}/storages/${stId}`); render(); } catch (e) { toast(e.message, 'error'); }
      },
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------- карточка хранилища у пилюли */
let POP = null;

function closePopover({ focus = false } = {}) {
  if (!POP) return;
  const { el, anchor } = POP;
  POP = null;
  el.remove();
  if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

function placePopover() {
  if (!POP) return;
  const a = POP.anchor.getBoundingClientRect();
  const p = POP.el;
  const w = p.offsetWidth, h = p.offsetHeight;
  const left = Math.min(Math.max(8, a.left), innerWidth - w - 8);
  let top = a.bottom + 8;
  if (top + h > innerHeight - 8 && a.top - h - 8 > 8) top = a.top - h - 8;
  p.style.left = `${left + scrollX}px`;
  p.style.top = `${top + scrollY}px`;
}

function openStPopover(stId, anchor) {
  const st = state.idx.st.get(stId);
  if (!st) return;
  if (POP?.anchor === anchor) { closePopover({ focus: true }); return; }
  closePopover();
  const r = route();
  const org = r?.page === 'org' ? state.idx.org.get(r.orgId) : null;
  const scope = scopeOf(st);
  const here = org ? storageUsages(st.id, org.id) : [];
  const all = storageUsages(st.id);
  const nOrgs = new Set(all.map((u) => u.org.id)).size;
  const el = document.createElement('div');
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Хранилище ${st.name}`);
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="pop-head">
      <span class="st-ico ${scope} big">${icon(stIcon(st), 20)}</span>
      <div class="pop-titles"><div class="pop-title">${esc(st.name)}</div>
        <div class="pop-sub">${esc(label('storage_types', st.type) || 'Тип не указан')}</div></div>
      <span class="scope-badge ${scope}">${ICON[scope]}${SCOPE_TEXT[scope]}</span>
    </div>
    ${st.address || st.location || st.notes ? `<dl class="pop-props">
      ${st.address ? `<dt>Адрес</dt><dd class="pop-addr"><code>${esc(st.address)}</code>
        <button type="button" class="link-btn" data-pop-copy>Копировать</button></dd>` : ''}
      ${st.location ? `<dt>Где</dt><dd>${esc(st.location)}</dd>` : ''}
      ${st.notes ? `<dt>Заметки</dt><dd class="pop-notes">${esc(st.notes)}</dd>` : ''}
    </dl>` : ''}
    ${org ? `<div class="pop-sec"><div class="pop-sec-title">${here.length
      ? `Копии этой организации: ${here.length}` : 'Копий этой организации здесь нет'}</div>
      ${here.length ? `<ul class="pop-uses">${here.slice(0, 6).map((u) => `<li>
        <a href="#org/${esc(org.id)}/set/${esc(u.set.id)}">${icon(typeIcon('set_types', u.set.type), 14)}<span>${esc(u.set.name)}</span></a>
        <span class="muted">${esc(u.dev.name)}, копия №${u.no}${isActive(u.copy) ? '' : ` · ${STAGE_SHORT[stageOf(u.copy)]}`}</span></li>`).join('')}
        ${here.length > 6 ? `<li class="muted">…и ещё ${here.length - 6}</li>` : ''}</ul>` : ''}</div>` : ''}
    <div class="pop-foot"><span class="muted">${all.length
      ? `Всего ${plural(all.length, 'копия', 'копии', 'копий')} в ${plural(nOrgs, 'организации', 'организациях', 'организациях')}`
      : 'Копий пока нет'}</span>
      <button type="button" class="btn btn-s" data-pop-edit>Изменить</button></div>`;
  document.body.append(el);
  POP = { el, anchor, stId };
  placePopover();
  el.focus({ preventScroll: true });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-pop-edit]')) {
      closePopover();
      openStorage(st.id);
    } else if (e.target.closest('[data-pop-copy]')) {
      navigator.clipboard?.writeText(st.address)
        .then(() => toast('Адрес скопирован'), () => toast('Не удалось скопировать адрес', 'error'));
    } else if (e.target.closest('a')) {
      closePopover();
    }
  });
}

/* ============================================================== EVENTS */
function applyTheme(t) {
  state.theme = THEMES[t] ? t : 'system';
  if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
  ls.set('bp.theme', state.theme);
  $$('#theme-switch [role=radio]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === state.theme)));
}

function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  $('.mobilebar [data-act=toggle-nav]')?.setAttribute('aria-expanded', String(open));
}

/* карточка хранилища открывается в разделе «Хранилища» (адрес #storages/<id>) */
function openStorage(id) {
  if (!state.idx.st.has(id)) return;
  if (ED?.dirty && ED.key !== `st:${id}`) { nudgeEditor(); return; }
  go(`storages/${id}`);
}

function addOrg() {
  if (ED?.dirty && ED.key !== 'org:new') { nudgeEditor(); return; }
  if (route()?.page === 'neworg') { focusFirst(); return; }
  location.hash = 'new';
}

const ACTIONS = {
  'add-org': () => addOrg(),
  'edit-org': (id) => orgEditor(state.idx.org.get(id)),
  'add-dev': (id) => deviceEditor(id),
  'edit-dev': (id) => deviceEditor(null, state.idx.dev.get(id)?.dev),
  'add-set': (id) => setEditor(id),
  'edit-set': (id) => setEditor(null, state.idx.set.get(id)?.set),
  'add-st': () => storageEditor(null),
  'add-st-org': (id) => storageEditor(null, { orgId: id }),
  'open-st': (id) => openStorage(id),
  'pop-st': (id, el) => openStPopover(id, el),
  'focus-copy': (id) => ED?.focusCopy?.(id),
  collapse: () => collapseEditor(),
  'attach-st': (id) => attachEditor(id),
  'detach-st': (id, el) => detachStorage(el.dataset.org, id),
  'edit-dict': (id) => dictEditor(id),
  'toggle-nav': () => setNav(!document.body.classList.contains('nav-open')),
  theme: (id) => applyTheme(id),
};

document.addEventListener('click', (e) => {
  if (e.target.closest('.ied, .pop')) return;
  const act = e.target.closest('[data-act]');
  if (!act) return;
  // не открывать форму, если пользователь выделял текст (например, копировал путь)
  if (!/^(BUTTON|A)$/.test(act.tagName) && getSelection().type === 'Range') return;
  ACTIONS[act.dataset.act]?.(act.dataset.id, act);
});

/* карточка хранилища закрывается кликом мимо неё */
document.addEventListener('pointerdown', (e) => {
  if (POP && !POP.el.contains(e.target) && !POP.anchor.contains(e.target)) closePopover();
}, true);
window.addEventListener('resize', () => closePopover());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (POP) {
    closePopover({ focus: true });
    e.preventDefault();
  } else if (ED?.el.isConnected) {
    if (ED.del && !$('.foot-confirm', ED.el).hidden) hideConfirm();
    else closeEditor();
    e.preventDefault();
  } else if (document.body.classList.contains('nav-open')) {
    setNav(false);
  }
});

window.addEventListener('hashchange', (e) => {
  try { state.prevHash = new URL(e.oldURL).hash.slice(1); } catch { state.prevHash = ''; }
  const r = route();
  if (!r) return;
  setNav(false);
  if (r.setId) state.flash = { key: `set:${r.setId}`, scroll: 'center' };
  const leftDirty = ED?.dirty && ED.el.isConnected;
  render();
  // ушли со страницы, где осталась форма с правками, — подсказать, как вернуться
  if (leftDirty && ED && !ED.el.isConnected) nudgeEditor();
  if (!r.setId && !ED?.el.isConnected) window.scrollTo(0, 0);
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('#org-list a');
  if (first) { e.preventDefault(); location.hash = first.getAttribute('href'); }
});

async function init() {
  applyTheme(state.theme);
  try {
    const [dicts, data] = await Promise.all([
      fetch('/api/dicts').then((r) => r.json()),
      fetch('/api/data').then((r) => r.json()),
    ]);
    applyDicts(dicts);
    state.data = data;
    reindex();
    const r = route();
    if (r?.setId) state.flash = { key: `set:${r.setId}`, scroll: 'center' };
    render();
  } catch (err) {
    $('#main').innerHTML = notFound('Нет связи с сервером',
      `Данные не загрузились (${err.message}). Проверьте, что сервер запущен через run.bat, и обновите страницу.`);
  }
}

init();

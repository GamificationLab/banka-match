// Banka Match PWA. Логика поверх дизайн-системы, данные из /shared.
import { verdict, LEVEL_LABELS } from '../shared/verdict.js';
import { planRecognition, cleanGuess } from '../shared/recognize.js';
import { productFromInci, looksTranslated } from '../shared/resolve-inci.js';

// Адрес воркера распознавания. null = честный экран «подключаем».
// После деплоя: 'https://banka-recognize.<аккаунт>.workers.dev' (см. worker/README.md)
const RECOGNIZE_URL = null;
const RECOGNIZE_TIMEOUT = 45000;
// Оценка ИИ для сочетаний, на которые в базе нет правила. Выключена:
// это единственное отступление от правила «ИИ объясняет, но не решает»,
// и включает его человек (решение 3 из PRD v3, раздел 9). Включать вместе
// с JUDGE_ENABLED в wrangler.toml.
const JUDGE_ENABLED = false;

// ---------- аналитика ----------
// Приёмник это тот же воркер, режим track. Отдельного счётчика и куки нет,
// адрес не хранится: события складываются в дневные счётчики на стороне
// воркера. Событий много, а записей в хранилище мало, поэтому они уходят
// пачкой: при уходе со страницы и раз в полминуты.
const ANALYTICS_ENDPOINT = RECOGNIZE_URL;
const FLUSH_EVERY = 30000;
let queue = [];

function flush() {
  if (!ANALYTICS_ENDPOINT || !queue.length) return;
  const events = queue.splice(0, 40);
  const body = JSON.stringify({ mode: 'track', events });
  try {
    // text/plain, чтобы маячок уходил без предварительного запроса:
    // sendBeacon его не умеет, а воркер разбирает тело в любом случае.
    const blob = new Blob([body], { type: 'text/plain' });
    if (navigator.sendBeacon && navigator.sendBeacon(ANALYTICS_ENDPOINT, blob)) return;
    fetch(ANALYTICS_ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
  } catch { /* не мешаем продукту */ }
}

function track(event, params = {}) {
  const payload = { event, ...params, device: deviceId(), platform: 'pwa', v: base?.version ?? null };
  if (!ANALYTICS_ENDPOINT) { console.debug('[track]', payload); return; }
  queue.push(payload);
  if (queue.length >= 40) flush();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  // Таймер не должен держать процесс живым в тестах на jsdom:
  // в браузере setInterval возвращает число, в ноде объект с unref.
  const timer = setInterval(flush, FLUSH_EVERY);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

// ---------- хранилище ----------
// Safari с настройкой «блокировать все cookie» и Chrome с запретом данных
// сайтов бросают исключение на любом обращении к localStorage. Без обёртки
// приложение умирает целиком и врёт про причину: человек видит «не
// получилось загрузить базу», хотя база уже скачалась.
let storageBroken = false;
function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    storageBroken = true;
    return null;
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    storageBroken = true;
    return false;
  }
}

// ---------- устройство и история (задел под полку: PRD раздел 6) ----------
let memoryDeviceId = null;
function deviceId() {
  let id = readStore('bm_device');
  if (!id) {
    id = memoryDeviceId || (Math.random().toString(36).slice(2) + Date.now().toString(36));
    memoryDeviceId = id;
    writeStore('bm_device', id);
  }
  return id;
}

const HISTORY_KEY = 'bm_history';
function loadHistory() {
  try {
    const raw = JSON.parse(readStore(HISTORY_KEY) || 'null');
    if (raw && raw.schema === 1) return raw;
  } catch { /* битые данные не роняют продукт */ }
  return { schema: 1, entries: [] };
}
// Экран вердикта перерисовывается на каждый возврат назад. Без ключа
// последней записи одна проверка попадала в историю по четыре раза,
// а метрика «сколько человек получили вердикт» врала втрое (review F14).
let lastSavedKey = null;
function saveCheck(A, B, state, gapped, source) {
  const key = [A.id, B.id].join('|');
  if (key === lastSavedKey) return false;
  lastSavedKey = key;
  const h = loadHistory();
  h.entries.unshift({
    ts: Date.now(),
    a: A.id, b: B.id,
    // Подписи снимаем в момент проверки: временное средство после
    // перезагрузки уже не найти, а строка истории должна остаться читаемой.
    an: `${A.brand || ''} ${A.name}`.trim(),
    bn: `${B.brand || ''} ${B.name}`.trim(),
    state, gapped, source,
  });
  h.entries = h.entries.slice(0, 50);
  writeStore(HISTORY_KEY, JSON.stringify(h));
  return true;
}

// ---------- состояние ----------
let base = null;
const pair = { a: null, b: null }; // id продуктов
let pairSource = 'manual';
// Название, прочитанное с этикетки: подставляется в поиск состава,
// чтобы человек не перепечатывал то, что мы уже прочитали.
let lookupPrefill = '';

const $ = (sel) => document.querySelector(sel);
// Средство, которого нет в каталоге: состав вставлен руками или прочитан
// с оборота. Живёт до перезагрузки, в историю не пишется, потому что
// восстановить его потом не из чего.
const adhoc = new Map();
let adhocSeq = 0;
const productById = (id) => base.products.find((p) => p.id === id) || adhoc.get(id) || null;
const isAdhoc = (id) => adhoc.has(id);
const activeById = (id) => base.actives.find((a) => a.id === id);
const goto = (hash) => { location.hash = hash; };
// Адрес несёт пару, чтобы ссылкой можно было поделиться. Хеш при этом
// остаётся именем экрана: видимость экранов держится на CSS-селекторе
// :target, и хеш вида #verdict/пара не показал бы ничего.
// Временные средства в адрес не попадают: у получателя их нет.
const shareable = () => Boolean(pair.a && pair.b && !isAdhoc(pair.a) && !isAdhoc(pair.b));
const shareUrl = () => `${location.origin}${location.pathname}?pair=${pair.a}+${pair.b}#verdict`;
function syncAddress() {
  const query = shareable() ? `?pair=${pair.a}+${pair.b}` : '';
  const next = `${location.pathname}${query}${location.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) {
    history.replaceState(null, '', next);
  }
}
// Пара из адреса: ссылка открывается у любого человека.
function pairFromAddress() {
  const raw = new URLSearchParams(location.search).get('pair');
  if (!raw) return null;
  const [a, b] = raw.split(/[+ ]/);
  if (!a || !b || a === b) return null;
  return { a, b };
}
// Редирект не должен оставлять запись в истории браузера: иначе кнопка
// «назад» возвращает на тот же пустой экран (review F29).
const redirect = (hash) => { location.replace(hash); };

const CHIP = {
  go: 'СОВМЕСТИМЫ',
  caution: 'С ОСТОРОЖНОСТЬЮ',
  stop: 'НЕ ВМЕСТЕ',
  none: 'КОНФЛИКТОВ НЕ НАШЛИ',
  unknown: 'НЕ ЗНАЕМ СОСТАВ',
  partial: 'РАЗОБРАЛИ ЧАСТИЧНО',
  known: 'ПО ИЗВЕСТНЫМ ДАННЫМ',
};
// Один расчёт подписи для экрана вердикта и для строки истории: раньше
// экран говорил «разобрали частично», а история подписывала ту же пару
// зелёным «совместимы» (review F13).
function chipFor(state, gapped) {
  if (state === 'unknown') return { label: CHIP.unknown, cls: 'none' };
  if (state === 'none') return { label: CHIP.none, cls: 'none' };
  if (gapped && state === 'go') return { label: CHIP.partial, cls: 'none' };
  return { label: CHIP[state] || state, cls: state };
}

const KIND_LABEL = {
  identity: 'справочник', efficacy: 'исследование', safety: 'безопасность',
  regulatory: 'регуляторика', method: 'методика', expert: 'мнение эксперта', alias: 'написание',
};
const SOURCE_LABEL = {
  catalog: 'состав из каталога',
  identity: 'состав сверен со справочником',
  label: 'состав прочитан с этикетки',
  photo: 'состав прочитан с фото оборота',
  lookup: 'состав найден по названию',
  manual: 'состав вставлен вручную',
  unconfirmed: 'состав не подтверждён',
};
// Откуда взялась пара: нужно в выгрузке проверок, чтобы понимать,
// каким путём человек дошёл до вердикта.
const SOURCE_TITLE = {
  manual: 'выбрано из базы',
  manual_inci: 'состав вставлен руками',
  inci_photo: 'состав снят с оборота',
  lookup: 'состав найден по названию',
  photo: 'узнано по фото',
  example: 'кнопка «попробовать на примере»',
  history: 'повтор из истории',
  link: 'открыто по ссылке',
};

const QUALITY_TEXT = { blur: 'фото размыто', glare: 'на этикетке блик', dark: 'слишком темно', partial: 'банка обрезана в кадре' };

// Русский счёт: 1 сочетание, 2 сочетания, 5 сочетаний.
function plural(n, one, few, many) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// ---------- мелкие рендеры ----------
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function text(tag, cls, value) {
  const n = el(tag, cls);
  n.textContent = value;
  return n;
}
function dots(level) {
  const wrap = el('span', 'dots' + (level <= 2 ? ' weak' : ''));
  for (let i = 0; i < 4; i++) wrap.appendChild(el('i', i < level ? 'on' : ''));
  return wrap;
}
function sig(level) {
  const wrap = el('div', 'sig');
  for (let i = 0; i < 4; i++) wrap.appendChild(el('i', i < level ? 'on' : ''));
  return wrap;
}
function cutTile(product, boxCls) {
  const box = el('div', boxCls);
  if (product.image) {
    const cut = el('div', 'cut');
    cut.style.backgroundImage = `url(../${product.image})`;
    box.appendChild(cut);
  } else {
    box.appendChild(text('span', 'brandletter', (product.brand || product.name || '?')[0]));
  }
  return box;
}
function orbitSvg(levels) {
  const shown = levels.slice(0, 4);
  if (shown.length < 2) return el('span', '');
  const cx = 173, cy = 105, r = 74;
  const byCount = { 2: [135, 45], 3: [135, 45, 270], 4: [135, 45, 225, 315] };
  let parts = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#CFC7B6" stroke-width="1"/>`;
  byCount[shown.length].forEach((ang, i) => {
    const a = (ang * Math.PI) / 180;
    const dx = Math.cos(a), dy = -Math.sin(a);
    const px = cx + r * dx, py = cy + r * dy;
    const ex = cx + (r + 30) * dx, ey = cy + (r + 30) * dy;
    const col = shown[i] <= 2 ? '#C07E22' : '#23407A';
    parts += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${col}" stroke-width="1" opacity=".45"/>` +
      `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="${col}"/>`;
  });
  const svg = el('div', '');
  svg.innerHTML = `<svg class="orb" viewBox="0 0 346 210" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${parts}</svg>`;
  return svg.firstChild;
}
function sourcesBox(sources) {
  const box = el('details', 'srcbox');
  const real = (sources || []).filter((s) => s.url);
  const summary = el('summary');
  if (!real.length) {
    summary.textContent = 'ссылок пока нет';
    box.appendChild(summary);
    box.appendChild(text('div', 'snote',
      'У этого вывода пока нет ссылок на исследования: он держится на практике косметологов. Мы дописываем ссылки и показываем их здесь, когда они появляются.'));
    return box;
  }
  summary.textContent = `источники: ${real.length}`;
  box.appendChild(summary);
  for (const s of real) {
    const a = el('a');
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener';
    const kind = el('span', 'skind');
    kind.textContent = KIND_LABEL[s.kind] || s.kind || '';
    a.appendChild(kind);
    a.appendChild(document.createTextNode(s.title || s.url));
    box.appendChild(a);
    if (s.note) box.appendChild(text('div', 'snote', s.note));
  }
  return box;
}

// Откуда взят состав пары. Экран не должен выглядеть увереннее, чем знает база.
function compositionLine(A, B) {
  const kinds = [A, B].map((p) => p.composition_source?.kind || 'catalog');
  const link = [A, B].find((p) => p.composition_source?.kind === 'lookup' && p.composition_source?.url);
  if (kinds.includes('manual')) {
    return { text: 'Состав вставлен вручную. Вердикт считают правила базы, сам состав мы не проверяли.' };
  }
  if (kinds.includes('photo')) {
    return { text: 'Состав прочитан с фото оборота. Модель только переписала строки, вердикт считают правила базы.' };
  }
  if (link) {
    return {
      text: 'Состав найден по названию в сети, вердикт считают правила базы.',
      url: link.composition_source.url,
    };
  }
  if (kinds.includes('unconfirmed')) {
    const who = [A, B].filter((p) => p.composition_source?.kind === 'unconfirmed')
      .map((p) => `${p.brand} ${p.name}`).join(' и ');
    return { text: `Состав не подтверждён: ${who}. У бренда есть похожие версии с другим составом, вердикт может измениться.` };
  }
  const unique = [...new Set(kinds)];
  return { text: unique.map((k) => SOURCE_LABEL[k] || k).join(', ') };
}

// ---------- экраны ----------
function renderHome() {
  const slots = $('#home-slots');
  slots.replaceChildren();
  for (const key of ['a', 'b']) {
    const id = pair[key];
    const slot = el('div', 'slot');
    const p = id ? productById(id) : null;
    if (p) {
      slot.appendChild(cutTile(p, 'shot'));
      const kill = el('button', 'kill', '×');
      kill.setAttribute('aria-label', 'Убрать средство');
      kill.addEventListener('click', (e) => { e.stopPropagation(); pair[key] = null; renderHome(); });
      slot.appendChild(kill);
      const found = el('div', 'found');
      found.appendChild(text('span', 'tick', '✓'));
      const label = el('span');
      label.appendChild(document.createTextNode('выбрано'));
      label.appendChild(el('br'));
      label.appendChild(text('b', '', `${p.brand} ${p.name}`));
      found.appendChild(label);
      slot.appendChild(found);
    } else {
      if (id) pair[key] = null; // запись из истории про удалённый продукт
      const firstEmpty = (key === 'a') || pair.a;
      const drop = el('div', 'drop' + (firstEmpty ? ' next' : ''));
      drop.appendChild(el('div', 'plus', '+'));
      drop.appendChild(text('div', 'dlabel', key === 'a' ? 'первое средство' : 'второе средство'));
      slot.appendChild(drop);
      slot.addEventListener('click', () => { goto(`#picker-${key}`); });
    }
    slots.appendChild(slot);
  }
  const ready = pair.a && pair.b;
  const cta = $('#home-cta');
  cta.className = ready ? 'btn' : 'btn off';
  $('#home-hint').textContent = ready
    ? 'Всё на месте'
    : 'Выберите два средства, чтобы проверить';
  cta.onclick = ready ? () => { pairSource = 'manual'; goto('#verdict'); } : null;
  const h = loadHistory();
  $('#home-history').textContent = h.entries.length ? `мои проверки · ${h.entries.length}` : 'мои проверки';
}

function renderPicker(key) {
  const section = $(`#picker-${key}`);
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = '#home';
  back.setAttribute('aria-label', 'Назад');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', key === 'a' ? 'Первое средство' : 'Второе средство'));
  section.appendChild(text('p', 'sub', 'Ищите по бренду, названию или транслиту. Средства нет в списке: внизу три способа добавить его самой.'));

  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = 'бренд или название';
  search.setAttribute('aria-label', 'Поиск средства');
  section.appendChild(search);

  const list = el('div', 'plist');
  const empty = text('p', 'nores', 'Ничего не нашли. Средство можно добавить самой: способы ниже.');
  empty.hidden = true;
  const other = key === 'a' ? pair.b : pair.a;

  const haystack = (p) => [p.brand, p.name, p.kind || '', ...(p.aliases || [])].join(' ').toLowerCase();
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    list.replaceChildren();
    let shown = 0;
    for (const p of base.products) {
      const hay = haystack(p);
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      shown++;
      const taken = p.id === other;
      const row = el('button', 'prow' + (taken ? ' taken' : ''));
      row.appendChild(cutTile(p, 'mini'));
      const t = el('div', 'pt');
      t.appendChild(text('div', 'pb', p.brand));
      t.appendChild(text('div', 'pn', p.name));
      // Одно средство в оба слота даёт вердикт «сам с собой» (review F08):
      // гасим его прямо в списке, а не ловим на экране вердикта.
      t.appendChild(text('div', 'pk', taken ? 'уже выбрано' : (p.kind || 'средство из базы')));
      row.appendChild(t);
      if (taken) row.disabled = true;
      else row.addEventListener('click', () => {
        pair[key] = p.id;
        pairSource = 'manual';
        goto('#home');
      });
      list.appendChild(row);
    }
    empty.hidden = shown > 0;
  };
  search.addEventListener('input', draw);
  draw();
  section.appendChild(list);
  section.appendChild(empty);

  // Средства не из каталога. Путь «вставить состав» работает офлайн
  // и без распознавания, поэтому он здесь всегда; остальные два появляются
  // вместе с воркером.
  const exits = el('div', 'exits');
  exits.appendChild(text('div', 'flabel', 'средства тут нет?'));
  exits.appendChild(text('p', 'sub', 'Вердикт посчитают те же правила, каким бы способом состав ни попал в приложение.'));
  const paste = el('a', 'btn', 'Вставить состав');
  paste.href = `#paste-${key}`;
  exits.appendChild(paste);
  if (RECOGNIZE_URL) {
    const byName = el('a', 'btn ghost', 'Найти состав по названию');
    byName.href = `#lookup-${key}`;
    byName.dataset.query = search.value.trim();
    byName.addEventListener('click', () => { lookupPrefill = search.value.trim(); });
    exits.appendChild(byName);
    const shot = el('a', 'btn ghost', 'Снять оборот с составом');
    shot.href = `#back-${key}`;
    exits.appendChild(shot);
  } else {
    exits.appendChild(text('p', 'sub',
      'Чтение состава с фото и поиск по названию мы сейчас подключаем. Пока работает ручная вставка, это тот же вердикт.'));
  }
  section.appendChild(exits);
}

// ---------- общий блок: что нашли в составе ----------
// Один и тот же разбор показывают три пути: с оборота, по названию
// и вставленный руками. Экран обязан выглядеть одинаково во всех трёх.
function renderResolved(box, resolved, raw) {
  box.replaceChildren();
  if (!resolved.actives.length) {
    // Русский перевод состава это не ошибка человека, а другой формат.
    box.appendChild(text('div', 'gapnote', looksTranslated(raw ?? '')
      ? 'Похоже, это состав в переводе на русский. Нам нужен тот, что напечатан на банке латиницей после слова Ingredients: по нему составы сверяет весь мир, а перевод у каждого магазина свой.'
      : `Разобрали ${resolved.components} ${plural(resolved.components, 'компонент', 'компонента', 'компонентов')}, но активных ингредиентов среди них не нашли. Так бывает у совсем простых средств, а ещё если список скопировался не целиком.`));
    return false;
  }
  box.appendChild(text('div', 'flabel', 'что нашли в составе'));
  const tags = el('div', 'chiplist');
  for (const a of resolved.actives) {
    const meta = activeById(a.id);
    tags.appendChild(text('span', `tag${a.role === 'support' ? ' support' : ''}`, meta ? meta.name : a.id));
  }
  box.appendChild(tags);
  box.appendChild(text('p', 'sub',
    `Компонентов ${resolved.components}, из них активных ${resolved.actives.length}. Вспомогательных, вроде воды и консервантов, ${resolved.excipients.length}.`));
  if (resolved.unknown.length) {
    box.appendChild(text('div', 'gapnote',
      `Не узнали ${resolved.unknown.length} ${plural(resolved.unknown.length, 'компонент', 'компонента', 'компонентов')}: ${resolved.unknown.slice(0, 6).join(', ')}${resolved.unknown.length > 6 ? ' и другие' : ''}. Вердикт будет по тем, что знаем.`));
  }
  return true;
}

// Временное средство встаёт в слот и уходит в очередь пополнения базы.
function useAdhoc(key, product, source) {
  adhoc.set(product.id, product);
  pair[key] = product.id;
  pairSource = source;
  goto('#home');
}

// ---------- путь Д: состав вставлен руками ----------
function renderPaste(key) {
  const section = $(`#paste-${key}`);
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = `#picker-${key}`;
  back.setAttribute('aria-label', 'Назад');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', 'Состав средства'));
  section.appendChild(text('p', 'sub',
    'Вставьте список INCI: с сайта магазина, из карточки товара или перепишите с оборота. Разбор идёт на телефоне, в сеть ничего не уходит.'));

  const area = el('textarea', 'inci-box');
  area.placeholder = 'Aqua, Glycerin, Niacinamide, Butylene Glycol...';
  area.setAttribute('aria-label', 'Список INCI');
  section.appendChild(area);

  const parsed = el('div', 'parsed');
  section.appendChild(parsed);

  const use = el('button', 'btn off', 'Использовать это средство');
  let ready = null;

  area.addEventListener('input', () => {
    ready = null;
    use.className = 'btn off';
    const raw = area.value.trim();
    if (!raw) { parsed.replaceChildren(); return; }
    const { product, resolved } = productFromInci(raw, base, { id: `adhoc-${++adhocSeq}` });
    if (renderResolved(parsed, resolved, raw)) {
      ready = product;
      use.className = 'btn';
    }
  });

  section.appendChild(el('div', 'grow'));
  use.addEventListener('click', () => {
    if (!ready) return;
    track('inci_paste', { actives: ready.actives.length });
    useAdhoc(key, ready, 'manual_inci');
  });
  section.appendChild(use);
}

// ---------- путь Г: состав по названию ----------
function renderLookup(key) {
  const section = $(`#lookup-${key}`);
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = `#picker-${key}`;
  back.setAttribute('aria-label', 'Назад');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', 'Найти по названию'));
  section.appendChild(text('p', 'sub',
    'Напишите бренд и название как на банке. Мы поищем состав в справочниках косметики и покажем ссылку на источник.'));

  const input = el('input', 'search');
  input.type = 'search';
  input.placeholder = 'например, CeraVe Moisturizing Cream';
  input.setAttribute('aria-label', 'Бренд и название');
  input.value = lookupPrefill;
  lookupPrefill = '';
  section.appendChild(input);

  const parsed = el('div', 'parsed');
  section.appendChild(parsed);
  section.appendChild(el('div', 'grow'));

  const find = el('button', 'btn', 'Найти состав');
  let ready = null;
  let run = 0;

  const use = el('button', 'btn off', 'Использовать это средство');
  use.addEventListener('click', () => {
    if (!ready) return;
    useAdhoc(key, ready, 'lookup');
  });

  find.addEventListener('click', async () => {
    const query = input.value.trim();
    if (query.length < 3) {
      parsed.replaceChildren(text('div', 'gapnote', 'Напишите бренд и название целиком: по двум буквам искать нечего.'));
      return;
    }
    const mine = ++run;
    ready = null;
    use.className = 'btn off';
    parsed.replaceChildren(text('p', 'sub', 'Ищем состав в справочниках, это занимает несколько секунд...'));
    const started = Date.now();
    let data;
    try {
      const res = await fetch(RECOGNIZE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'lookup', query }),
        signal: AbortSignal.timeout(RECOGNIZE_TIMEOUT),
      });
      data = await res.json();
    } catch (e) {
      if (mine !== run) return;
      const aborted = e && e.name === 'AbortError';
      track('lookup', { outcome: aborted ? 'timeout' : 'network' });
      parsed.replaceChildren(text('div', 'gapnote', aborted
        ? 'Поиск не ответил за сорок пять секунд. Попробуйте ещё раз или вставьте состав руками.'
        : 'Не получилось связаться с поиском. Проверьте сеть или вставьте состав руками.'));
      return;
    }
    if (mine !== run) return;
    const seconds = Math.round((Date.now() - started) / 1000);

    if (!data.ok) {
      const MSG = {
        quota_lookup: 'На сегодня поиск состава по названию закончился. Состав можно вставить руками, это работает без ограничений.',
        quota_hour: 'С этой сети сейчас много запросов. Попробуйте через час или вставьте состав руками.',
        quota_day: 'На сегодня запросы закончились. Вставка состава руками работает без ограничений.',
      };
      track('lookup', { outcome: data.error || 'error', seconds });
      parsed.replaceChildren(text('div', 'gapnote', MSG[data.error] || 'Что-то пошло не так с нашей стороны. Попробуйте ещё раз.'));
      return;
    }

    const r = data.result;
    track('lookup', {
      outcome: r.found ? 'found' : 'not_found',
      query: r.found ? undefined : query.slice(0, 80),
      cached: Boolean(data.cached),
      cost_cents: data.cost_cents ?? null,
      seconds,
    });
    if (!r.found || !r.inci.length) {
      parsed.replaceChildren(text('div', 'gapnote',
        'Состав этого средства мы не нашли. Это честное «не нашли»: выдумывать состав нельзя. Перепишите его с оборота банки или вставьте с сайта магазина.'));
      const paste = el('a', 'btn ghost', 'Вставить состав руками');
      paste.href = `#paste-${key}`;
      parsed.appendChild(paste);
      return;
    }

    const { product, resolved } = productFromInci(r.inci, base, {
      id: `adhoc-${++adhocSeq}`,
      name: r.product_title || query,
      composition_source: r.source_url
        ? { kind: 'lookup', url: r.source_url }
        : { kind: 'unconfirmed', note: 'состав найден, но ссылку на источник модель не дала' },
    });
    parsed.replaceChildren();
    parsed.appendChild(text('div', 'flabel', r.source_url ? 'нашли' : 'нашли, но без источника'));
    parsed.appendChild(text('p', '', product.name));
    if (r.source_url) {
      const link = el('a', 'srclink');
      link.href = r.source_url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = r.source_url.replace(/^https?:\/\//, '');
      parsed.appendChild(link);
    } else {
      parsed.appendChild(text('div', 'gapnote',
        'Ссылку на источник модель не дала, поэтому состав считается неподтверждённым. Экран вердикта скажет об этом же.'));
    }
    const box = el('div', 'parsed');
    parsed.appendChild(box);
    if (renderResolved(box, resolved, r.inci)) {
      ready = product;
      use.className = 'btn';
    }
  });

  section.appendChild(find);
  section.appendChild(use);
  const paste = el('a', 'btn ghost', 'Вставить состав руками');
  paste.href = `#paste-${key}`;
  section.appendChild(paste);
}

// ---------- путь В: фото оборота с составом ----------
function renderBack(key) {
  const section = $(`#back-${key}`);
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = `#picker-${key}`;
  back.setAttribute('aria-label', 'Назад');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', 'Оборот с составом'));
  section.appendChild(text('p', 'sub',
    'Снимите список ингредиентов крупно и ровно. Модель только перепишет строки, вердикт посчитают правила базы. Фото уйдёт на распознавание и у нас не сохранится.'));

  const parsed = el('div', 'parsed');
  section.appendChild(parsed);

  const input = el('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  section.appendChild(input);

  const use = el('button', 'btn off', 'Использовать это средство');
  let ready = null;
  let run = 0;

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const mine = ++run;
    ready = null;
    use.className = 'btn off';
    parsed.replaceChildren(text('p', 'sub', 'Читаем состав, это занимает несколько секунд...'));
    let image;
    try {
      image = await compressImage(file);
    } catch {
      parsed.replaceChildren(text('div', 'gapnote',
        'Не получилось прочитать этот файл. Такое бывает с форматом HEIC: попробуйте другой снимок или вставьте состав руками.'));
      return;
    }
    let data;
    try {
      const res = await fetch(RECOGNIZE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image, mode: 'inci' }),
        signal: AbortSignal.timeout(RECOGNIZE_TIMEOUT),
      });
      data = await res.json();
    } catch (e) {
      if (mine !== run) return;
      const aborted = e && e.name === 'AbortError';
      track('inci_photo', { outcome: aborted ? 'timeout' : 'network' });
      parsed.replaceChildren(text('div', 'gapnote', aborted
        ? 'Распознавание не ответило за сорок пять секунд. Попробуйте ещё раз или вставьте состав руками.'
        : 'Не получилось связаться с распознаванием. Проверьте сеть или вставьте состав руками.'));
      return;
    }
    if (mine !== run) return;
    if (!data.ok) {
      track('inci_photo', { outcome: data.error || 'error' });
      parsed.replaceChildren(text('div', 'gapnote',
        data.error === 'quota_hour'
          ? 'С этой сети сейчас много проверок. Попробуйте через час или вставьте состав руками.'
          : 'Что-то пошло не так с нашей стороны. Попробуйте ещё раз или вставьте состав руками.'));
      return;
    }
    const lines = data.result?.inci || [];
    track('inci_photo', { outcome: lines.length ? 'read' : 'empty', lines: lines.length, cost_cents: data.cost_cents ?? null });
    if (!lines.length) {
      parsed.replaceChildren(text('div', 'gapnote',
        'Строк состава на фото не разобрать. Снимите этикетку крупнее и без бликов или вставьте состав руками.'));
      return;
    }
    const { product, resolved } = productFromInci(lines, base, {
      id: `adhoc-${++adhocSeq}`,
      composition_source: { kind: 'photo' },
    });
    parsed.replaceChildren();
    if (renderResolved(parsed, resolved, lines)) {
      ready = product;
      use.className = 'btn';
    }
  });

  section.appendChild(el('div', 'grow'));
  const pick = el('button', 'btn', 'Снять оборот');
  pick.addEventListener('click', () => input.click());
  section.appendChild(pick);
  use.addEventListener('click', () => {
    if (!ready) return;
    useAdhoc(key, ready, 'inci_photo');
  });
  section.appendChild(use);
  const paste = el('a', 'btn ghost', 'Вставить состав руками');
  paste.href = `#paste-${key}`;
  section.appendChild(paste);
}

function renderVerdict() {
  const section = $('#verdict');
  if (!pair.a || !pair.b || !productById(pair.a) || !productById(pair.b)) { redirect('#home'); return; }
  const A = productById(pair.a);
  const B = productById(pair.b);
  section.replaceChildren();
  // Назад к выбору, не теряя пару: единственная кнопка внизу стирает обе
  // банки, и человек, который хотел поменять одну, начинает сначала.
  const back = el('a', 'back', '‹');
  back.href = '#home';
  back.setAttribute('aria-label', 'Назад к выбору');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', 'Сочетаются ли?'));

  const v = verdict(A, B, base);
  syncAddress();

  // Одно и то же средство в двух слотах: вердикта не бывает, бывает подсказка.
  if (v.same) {
    const card = el('div', 'vcard');
    card.appendChild(text('div', 'verdict', 'Это одно и то же средство'));
    card.appendChild(text('p', 'vbody',
      `В обоих слотах стоит ${A.brand} ${A.name}. Выберите второе средство, и мы сравним их между собой.`));
    section.appendChild(card);
    section.appendChild(el('div', 'grow'));
    const pick = el('a', 'btn', 'Выбрать второе средство');
    pick.href = '#picker-b';
    pick.addEventListener('click', () => { pair.b = null; });
    section.appendChild(pick);
    return;
  }

  const gapped = Boolean(v.uncovered?.length);
  const chip = chipFor(v.state, gapped);
  // Повтор из истории и открытие по ссылке это не новая проверка:
  // иначе одна пара размножается в списке при каждом заходе. А вот
  // вставленный состав писать надо: на тесте это самый частый сценарий,
  // и без записи о нём не остаётся вообще ничего.
  const storable = pairSource !== 'history' && pairSource !== 'link';
  if (storable && saveCheck(A, B, v.state, gapped, pairSource)) {
    track('verdict', {
      pair: [A.id, B.id].sort().join('+'),
      state: v.state,
      level: v.winner?.level ?? null,
      fallback: Boolean(v.winner?.fallback),
      sourced: Boolean((v.winner?.sources || []).some((x) => x.url)),
      rules_fired: v.fired.length,
      // Непокрытые комбинации это очередь на наполнение базы: что зал
      // спрашивал и на что мы ответили не полностью.
      gaps: (v.uncovered || []).map(([x, y]) => [x.id, y.id].sort().join('x')).join(' '),
      unknown: v.unknownActives.length,
      source: pairSource,
    });
  }

  const cards = el('div', 'cards s2');
  [['a', A], ['b', B]].forEach(([slot, p]) => {
    const card = el('a', 'pcard');
    card.href = `#prod-${slot}`;
    card.appendChild(cutTile(p, 'ptile'));
    card.appendChild(text('div', 'pname', `${p.brand} ${p.name}`));
    card.appendChild(text('div', 'plink', 'разбор ›'));
    cards.appendChild(card);
  });
  section.appendChild(cards);

  const card = el('div', 'vcard');
  card.appendChild(text('span', `chip ${chip.cls}`, chip.label));
  const source = compositionLine(A, B);
  card.appendChild(text('div', 'csource', source.text));
  if (source.url) {
    const link = el('a', 'srclink');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = source.url.replace(/^https?:\/\//, '');
    card.appendChild(link);
  }

  if (v.state === 'unknown') {
    card.appendChild(text('div', 'verdict', 'Не знаем состав'));
    card.appendChild(text('p', 'vbody',
      'Ни один компонент из этого средства не нашёлся в нашей базе, поэтому вердикта не будет. Это честное «не знаю», а не ошибка.'));
    if (v.unknownActives.length) {
      card.appendChild(text('div', 'gapnote', `Не разобрали: ${v.unknownActives.join(', ')}.`));
    }
    section.appendChild(card);
    section.appendChild(el('div', 'grow'));
    const pick = el('a', 'btn', 'Выбрать из базы руками');
    pick.href = '#home';
    section.appendChild(pick);
    return;
  }

  // Вывод по половине состава не должен выглядеть выводом по всему составу.
  const partialGo = gapped && v.state === 'go' && v.winner;
  card.appendChild(text('div', 'verdict', partialGo
    ? 'Разобрали часть состава'
    : (v.winner ? v.winner.head : 'Конфликтов не нашли')));
  if (partialGo) {
    card.appendChild(text('div', 'flabel', 'по известной части'));
  }
  card.appendChild(text('p', 'vbody', v.winner
    ? v.winner.body
    : 'Среди активов этой пары наши правила конфликтов не нашли. Это честное «не нашли», а не «всё отлично»: загляните в разбор каждого средства, ценность там.'));

  // Правило со стороной «что угодно» говорит про один компонент, а не про
  // эту конкретную пару. Вердикт от этого не перестаёт быть верным, но
  // делать вид, что база знает про пару, нечестно.
  if (v.winner && v.winner.fallback) {
    card.appendChild(text('div', 'gapnote',
      'Это общее правило про один из компонентов. Отдельного правила именно для такой пары у нас пока нет, и мы записали её себе.'));
  }

  // Правил срабатывает много, но человеку нужны те, что говорят про пару,
  // а не про то, что увлажнение ничему не мешает. Показываем до трёх
  // и сначала адресные.
  const rest = v.fired.slice(1)
    .filter((r) => r.a !== 'any' && r.b !== 'any')
    .slice(0, 3);
  if (rest.length) {
    const also = el('div', 'also');
    also.appendChild(text('div', 'flabel', 'ещё обратите внимание'));
    for (const r of rest) {
      const row = el('div', 'alsorow');
      row.appendChild(el('span', `dot ${r.state}`));
      row.appendChild(text('span', '', r.head));
      also.appendChild(row);
    }
    card.appendChild(also);
  }

  // Вывод сделан не по всему составу: говорим об этом словами. Молчание
  // здесь превращает «можно вместе» в обещание, которого мы не давали.
  if (gapped) {
    const names = [...new Set(v.uncovered.map(([x, y]) => `${x.name} и ${y.name}`))];
    const body = names.length === 1
      ? `про сочетание «${names[0]}» правила у нас пока нет`
      : `правил пока нет для ${names.length} ${plural(names.length, 'сочетания', 'сочетаний', 'сочетаний')} активов, среди них «${names[0]}»`;
    card.appendChild(text('div', 'gapnote',
      `Вывод выше сделан не по всему составу: ${body}. Мы записываем такие пробелы и закрываем их правилами.`));
  }
  if (v.unknownActives.length) {
    card.appendChild(text('div', 'gapnote',
      `Часть компонентов мы не узнали: ${v.unknownActives.join(', ')}. Вердикт выше только по тем, что знаем.`));
  }
  // Вставленный состав почти всегда содержит компоненты, которых нет в базе.
  // Экран вставки о них честно сказал, экран вердикта обязан тоже.
  const rawUnknown = [...new Set([A, B].flatMap((p) => p.unknown_raw || []))];
  if (rawUnknown.length) {
    card.appendChild(text('div', 'gapnote',
      `В составе ещё ${rawUnknown.length} ${plural(rawUnknown.length, 'компонент', 'компонента', 'компонентов')}, которых нет в нашей базе: ${rawUnknown.slice(0, 5).join(', ')}${rawUnknown.length > 5 ? ' и другие' : ''}. Про них мы ничего не говорим.`));
  }

  // Оценка ИИ живёт вне пирамиды доказательности: отдельный чип, честная
  // подпись и очередь на вычитку. Кнопка появляется только там, где
  // у базы правил нет, и только когда режим включён.
  if (JUDGE_ENABLED && RECOGNIZE_URL && gapped) {
    const box = el('div', 'notecard');
    box.appendChild(text('div', 'flabel', 'правил на это сочетание у нас нет'));
    box.appendChild(text('p', '',
      'Можно спросить ИИ. Это не вердикт базы: такая оценка не входит в пирамиду доказательности и уйдёт к нам на вычитку.'));
    const ask = el('button', 'btn ghost', 'Спросить ИИ');
    ask.style.marginTop = '10px';
    ask.addEventListener('click', async () => {
      const [x, y] = v.uncovered[0];
      ask.disabled = true;
      ask.textContent = 'Спрашиваем...';
      let data;
      try {
        const res = await fetch(RECOGNIZE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'judge', a: x.id, b: y.id }),
          signal: AbortSignal.timeout(RECOGNIZE_TIMEOUT),
        });
        data = await res.json();
      } catch { data = null; }
      track('judge', { pair: [x.id, y.id].sort().join('x'), ok: Boolean(data?.ok), cost_cents: data?.cost_cents ?? null });
      ask.remove();
      if (!data?.ok) {
        box.appendChild(text('div', 'gapnote', 'Оценку получить не удалось. Вердикт выше остаётся по известной части состава.'));
        return;
      }
      box.appendChild(text('span', 'chip none', 'ОЦЕНКА ИИ, НЕ ПРОВЕРЕНА'));
      box.appendChild(text('div', 'verdict', data.result.head));
      box.appendChild(text('p', 'vbody', data.result.body));
      if (data.result.rationale) box.appendChild(text('p', 'sub', data.result.rationale));
      box.appendChild(text('div', 'gapnote',
        `Это про сочетание «${x.name} и ${y.name}». Оценка не входит в пирамиду доказательности и уйдёт на вычитку: если она подтвердится, в базе появится правило.`));
    });
    box.appendChild(ask);
    card.appendChild(box);
  }

  if (v.spfNote) {
    card.appendChild(text('div', 'spfnote',
      '☀ В паре есть активы, чувствительные к солнцу: утром SPF обязателен.'));
  } else if (v.spfLast) {
    card.appendChild(text('div', 'spfnote',
      '☀ Санскрин идёт последним слоем, и его должно быть не жалко.'));
  }

  if (v.winner) {
    const meter = el('div', 'meter');
    meter.appendChild(sig(v.winner.level));
    const mt = el('div', 'mt');
    mt.appendChild(text('b', '', `Доказательность: ${v.winner.level} из 4, ${LEVEL_LABELS[v.winner.level]}`));
    mt.appendChild(text('span', '', 'уровень этого вывода, не самих средств'));
    meter.appendChild(mt);
    const q = el('a', 'q', '?');
    q.href = '#pyramid';
    q.setAttribute('aria-label', 'Что значит доказательность');
    meter.appendChild(q);
    card.appendChild(meter);
    card.appendChild(sourcesBox(v.winner.sources));
    card.appendChild(el('hr', 'vhr'));
  } else {
    const mt = el('div', 'mt');
    mt.appendChild(text('span', 'sub', 'Правил для этой пары в базе пока нет.'));
    card.appendChild(mt);
  }
  section.appendChild(card);

  section.appendChild(text('p', 'disclaimer',
    'Это справка о сочетании косметики, не медицинский совет. При кожных заболеваниях, беременности или назначениях врача сверяйтесь с врачом.'));

  // Средство не из каталога уходит в очередь пополнения базы: так каждая
  // незнакомая банка становится кандидатом в каталог (PRD v3, раздел 5).
  const fresh = [A, B].filter((p) => isAdhoc(p.id)
    && ['photo', 'manual'].includes(p.composition_source?.kind)
    && (p.inci_raw || []).length);
  if (fresh.length && RECOGNIZE_URL) {
    const box = el('div', 'notecard');
    box.appendChild(text('div', 'flabel', 'помочь базе'));
    box.appendChild(text('p', '',
      'Этого средства у нас нет. Можно отправить его название и состав в очередь на добавление: фото и ничего личного не уходит.'));
    const send = el('button', 'btn ghost', 'Добавить в базу');
    send.style.marginTop = '10px';
    send.addEventListener('click', async () => {
      send.disabled = true;
      send.textContent = 'Отправляем...';
      let ok = false;
      try {
        for (const p of fresh) {
          const res = await fetch(RECOGNIZE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'intake',
              query: (p.name || 'средство без названия').slice(0, 120),
              inci: (p.inci_raw || []).slice(0, 80),
            }),
            signal: AbortSignal.timeout(15000),
          });
          ok = (await res.json()).ok === true;
        }
      } catch { ok = false; }
      track('intake_send', { ok, products: fresh.length });
      send.textContent = ok ? 'Спасибо, добавили в очередь' : 'Не получилось, попробуйте позже';
    });
    box.appendChild(send);
    section.appendChild(box);
  }

  // Ссылкой на вердикт можно поделиться: пара лежит в адресе.
  if (!isAdhoc(A.id) && !isAdhoc(B.id) && navigator.clipboard) {
    const share = el('button', 'btn ghost', 'Скопировать ссылку на эту пару');
    share.style.marginTop = '14px';
    share.addEventListener('click', async () => {
      const url = shareUrl();
      try {
        await navigator.clipboard.writeText(url);
        share.textContent = 'Ссылка скопирована';
        track('share', { pair: [A.id, B.id].sort().join('+') });
      } catch {
        share.textContent = 'Не получилось скопировать';
      }
    });
    section.appendChild(share);
  }

  const hint = installHint();
  if (hint) section.appendChild(hint);
  section.appendChild(el('div', 'grow'));
  const again = el('a', 'btn', 'Проверить другую пару');
  again.href = '#home';
  again.addEventListener('click', () => { pair.a = null; pair.b = null; renderHome(); });
  section.appendChild(again);
}

function renderProduct(slot) {
  const id = pair[slot];
  if (!id || !productById(id)) { redirect('#home'); return; }
  const p = productById(id);
  track('product_open', { product: p.id });
  const section = $(`#prod-${slot}`);
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = '#verdict';
  back.setAttribute('aria-label', 'Назад к вердикту');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', `${p.brand} ${p.name}`));
  if (p.kind) section.appendChild(text('p', 'sub', p.kind));
  section.appendChild(text('p', 'src', p.status === 'verified'
    ? 'разбор проверен косметологом'
    : 'разбор ещё не проверен косметологом'));
  // Откуда состав. Заметки конвейера сюда не попадают: они для вычитки,
  // а человеку нужна одна строка и ссылка.
  const cs = p.composition_source;
  if (cs) {
    section.appendChild(text('p', 'src', SOURCE_LABEL[cs.kind] || cs.kind));
    if (cs.note) section.appendChild(text('p', 'sub', cs.note));
    if (cs.url) {
      const link = el('a', 'srclink');
      link.href = cs.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = cs.title || cs.url.replace(/^https?:\/\//, '');
      section.appendChild(link);
    }
  }

  const acts = p.actives.map((a) => ({ ...a, meta: activeById(a.id) })).filter((a) => a.meta);
  const main = acts.filter((a) => a.role !== 'support');
  const ring = el('div', 'ring');
  const top = main.slice(0, 4);
  const sides = top.length === 4 ? ['l', 'r', 'l', 'r'] : top.length === 3 ? ['l', 'r', 'wide'] : ['l', 'r'];
  const nodes = top.map((a, i) => {
    const box = el('div', `act a${i + 1} ${sides[i]}`);
    box.appendChild(text('div', 'aname', a.display || a.meta.name));
    box.appendChild(text('div', 'aben', a.benefit || a.meta.what));
    box.appendChild(dots(a.meta.level));
    return box;
  });
  if (nodes[0]) ring.appendChild(nodes[0]);
  if (nodes[1]) ring.appendChild(nodes[1]);
  const prod = el('div', 'prod');
  prod.appendChild(orbitSvg(top.map((a) => a.meta.level)));
  prod.appendChild(cutTileInner(p));
  ring.appendChild(prod);
  if (nodes[2]) ring.appendChild(nodes[2]);
  if (nodes[3]) ring.appendChild(nodes[3]);
  section.appendChild(ring);
  section.appendChild(text('p', 'hintline', 'точки: насколько доказан компонент'));

  const rest = acts.filter((a) => !top.includes(a));
  if (rest.length) {
    const box = el('div', 'actlist');
    box.appendChild(text('div', 'flabel', 'ещё в составе'));
    for (const a of rest) {
      const row = el('div', 'actrow');
      const an = el('div', 'an');
      an.appendChild(text('b', '', a.display || a.meta.name));
      an.appendChild(text('span', '', a.benefit || a.meta.what));
      row.appendChild(an);
      row.appendChild(dots(a.meta.level));
      box.appendChild(row);
    }
    section.appendChild(box);
  }

  // Находка это вывод разбора, а не поле из справочника. У продукта,
  // который приехал из очереди пополнения, её просто нет, и выдумывать
  // её нельзя: блок не показывается.
  if (p.find) {
    const find = el('div', 'find');
    find.appendChild(text('div', 'flabel', 'находка'));
    find.appendChild(text('p', '', p.find));
    section.appendChild(find);
  }

  const allSources = acts.flatMap((a) => a.meta.sources || []);
  section.appendChild(sourcesBox(allSources));

  section.appendChild(el('div', 'grow'));
  const backBtn = el('a', 'btn', 'Назад к вердикту');
  backBtn.href = '#verdict';
  section.appendChild(backBtn);
}

// картинка продукта в орбите: тот же cut, но отдельным узлом
function cutTileInner(p) {
  if (p.image) {
    const cut = el('div', 'cut');
    cut.style.backgroundImage = `url(../${p.image})`;
    return cut;
  }
  const holder = el('div', 'cut');
  holder.style.display = 'flex';
  holder.style.alignItems = 'center';
  holder.style.justifyContent = 'center';
  holder.appendChild(text('span', 'brandletter', (p.brand || p.name || '?')[0]));
  return holder;
}

function renderHistory() {
  const section = $('#history');
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = '#home';
  back.setAttribute('aria-label', 'Назад');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', 'Мои проверки'));
  // Обещание про «никуда не отправляются» перестаёт быть правдой в тот
  // день, когда включается счётчик. Текст меняется вместе с фактом.
  section.appendChild(text('p', 'sub', ANALYTICS_ENDPOINT
    ? 'Проверки хранятся на этом телефоне. Отдельно мы считаем обезличенную статистику: какие пары проверяют и где у базы дыры. Названия средств и пары уходят в счётчик, ничего личного о вас там нет.'
    : 'Проверки хранятся на этом телефоне и никуда не отправляются.'));
  const h = loadHistory();
  // Строку рисуем по подписи, снятой в момент проверки: временное средство
  // после перезагрузки не найти, но проверка была, и терять её нельзя.
  const rows = h.entries.filter((e) => (e.an && e.bn) || (productById(e.a) && productById(e.b)));
  if (!rows.length) {
    section.appendChild(text('p', 'empty', storageBroken
      ? 'Этот браузер не разрешает сайтам ничего запоминать, поэтому проверки здесь не сохраняются. Сами проверки при этом работают как обычно.'
      : 'Пока пусто. Проверьте первую пару, она появится здесь.'));
  } else {
    const list = el('div', 'plist');
    for (const e of rows) {
      const a = productById(e.a);
      const b = productById(e.b);
      const replayable = Boolean(a && b);
      const row = el('button', 'hrow' + (replayable ? '' : ' taken'));
      const t = el('div', 'ht');
      const label = replayable
        ? `${a.brand} ${a.name} + ${b.brand} ${b.name}`
        : `${e.an || 'средство'} + ${e.bn || 'средство'}`;
      t.appendChild(text('div', 'hn', label));
      t.appendChild(text('div', 'hd', new Date(e.ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })));
      row.appendChild(t);
      const chip = chipFor(e.state, e.gapped);
      row.appendChild(text('span', `chip ${chip.cls}`, chip.label));
      if (replayable) {
        row.addEventListener('click', () => {
          pair.a = e.a; pair.b = e.b; pairSource = 'history';
          goto('#verdict');
        });
      } else {
        row.disabled = true;
        t.appendChild(text('div', 'hd', 'состав вставляли вручную, открыть заново нельзя'));
      }
      list.appendChild(row);
    }
    section.appendChild(list);
  }
  // Без аналитики единственный способ забрать результат теста с чужого
  // телефона это текст, который человек пришлёт в мессенджере.
  if (rows.length && navigator.clipboard) {
    const copy = el('button', 'btn ghost', 'Скопировать мои проверки текстом');
    copy.style.marginTop = '14px';
    copy.addEventListener('click', async () => {
      const lines = [`Banka Match, проверки. База ${base.version}. Всего ${rows.length}.`];
      for (const e of rows) {
        const a = productById(e.a);
        const b = productById(e.b);
        const label = a && b ? `${a.brand} ${a.name} + ${b.brand} ${b.name}` : `${e.an} + ${e.bn}`;
        const when = new Date(e.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(`${when} · ${label} · ${chipFor(e.state, e.gapped).label} · ${SOURCE_TITLE[e.source] || e.source}`);
      }
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        copy.textContent = 'Скопировано, можно вставить в переписку';
      } catch {
        copy.textContent = 'Не получилось скопировать';
      }
    });
    section.appendChild(copy);
  }

  section.appendChild(el('div', 'grow'));
  const backBtn = el('a', 'btn ghost', 'На главный');
  backBtn.href = '#home';
  section.appendChild(backBtn);
}

// ---------- крючок установки: один раз, после первого удачного вердикта ----------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => {
  writeStore('bm_install_done', '1');
  track('install', {});
});

function installHint() {
  if (readStore('bm_install_done')) return null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return null;
  const box = el('div', 'notecard');
  box.appendChild(text('div', 'flabel', 'чтобы была под рукой'));
  const isIos = /iphone|ipad/i.test(navigator.userAgent);
  box.appendChild(text('p', '', isIos
    ? 'Добавьте Banka на экран: кнопка «Поделиться» внизу Safari, затем «На экран "Домой"». История проверок останется с вами.'
    : 'Добавьте Banka на экран, история проверок останется с вами.'));
  if (!isIos && deferredInstall) {
    const btn = el('button', 'btn ghost', 'Добавить на экран');
    btn.style.marginTop = '10px';
    btn.addEventListener('click', async () => {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      box.remove();
    });
    box.appendChild(btn);
  }
  const later = el('button', 'btn ghost', 'Не сейчас');
  later.style.marginTop = '8px';
  later.addEventListener('click', () => { writeStore('bm_install_done', '1'); box.remove(); });
  box.appendChild(later);
  return box;
}

// ---------- фото: сжатие на клиенте (заодно сброс EXIF) и распознавание ----------
async function compressImage(file, maxSide = 1100) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // запасной путь для форматов, которые createImageBitmap не берёт
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('формат не читается'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  if (!w || !h) throw new Error('пустая картинка');
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function photoShell(sub) {
  const section = $('#photo');
  section.replaceChildren();
  const back = el('a', 'back', '‹');
  back.href = '#home';
  back.setAttribute('aria-label', 'Назад');
  section.appendChild(back);
  section.appendChild(text('h1', 'sm', 'Проверка по фото'));
  section.appendChild(text('p', 'sub', sub));
  return section;
}

function photoActions(section, retry = true) {
  section.appendChild(el('div', 'grow'));
  if (retry) {
    const again = el('button', 'btn ghost', 'Переснять');
    again.addEventListener('click', renderPhoto);
    section.appendChild(again);
  }
  const manual = el('a', 'btn', 'Выбрать из базы руками');
  manual.href = '#home';
  section.appendChild(manual);
}

function renderPhoto() {
  if (!RECOGNIZE_URL) { track('unknown_screen', { reason: 'photo_not_ready' }); return; }
  const section = photoShell('Один кадр, в нём одно или два средства. Фото уйдёт на распознавание и у нас не сохранится, гео-метки вычищаются до отправки.');
  const input = el('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', () => { if (input.files[0]) recognizeFlow(input.files[0]); });
  section.appendChild(input);
  section.appendChild(el('div', 'grow'));
  const pick = el('button', 'btn', 'Выбрать фото');
  pick.addEventListener('click', () => input.click());
  section.appendChild(pick);
  const manual = el('a', 'btn ghost', 'Выбрать из базы руками');
  manual.href = '#home';
  section.appendChild(manual);
}

// Ответ, пришедший после ухода с экрана, слоты не меняет (review F30).
let recognizeRun = 0;

async function recognizeFlow(file) {
  const run = ++recognizeRun;
  const started = Date.now();
  const controller = new AbortController();
  const waiting = photoShell('Читаем этикетку, это занимает несколько секунд...');
  waiting.appendChild(el('div', 'grow'));
  const cancel = el('button', 'btn ghost', 'Отменить');
  cancel.addEventListener('click', () => { recognizeRun++; controller.abort(); renderPhoto(); });
  waiting.appendChild(cancel);
  track('photo_upload', { from: 'gallery' });

  let image;
  try {
    image = await compressImage(file);
  } catch {
    track('recognition', { outcome: 'bad_file', seconds: 0 });
    photoActions(photoShell('Не получилось прочитать этот файл. Такое бывает с форматом HEIC: попробуйте другой снимок или сохраните его как JPEG.'));
    return;
  }

  let data;
  const timer = setTimeout(() => controller.abort(), RECOGNIZE_TIMEOUT);
  try {
    const res = await fetch(RECOGNIZE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, mode: 'front' }),
      signal: controller.signal,
    });
    data = await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (run !== recognizeRun) return;
    const aborted = e && e.name === 'AbortError';
    track('recognition', { outcome: aborted ? 'timeout' : 'network', seconds: Math.round((Date.now() - started) / 1000) });
    photoActions(photoShell(aborted
      ? 'Распознавание не ответило за сорок пять секунд. Попробуйте ещё раз или выберите средство из базы.'
      : 'Не получилось связаться с распознаванием. Проверьте сеть и попробуйте ещё раз.'));
    return;
  }
  clearTimeout(timer);
  if (run !== recognizeRun) return;

  const seconds = Math.round((Date.now() - started) / 1000);
  if (!data.ok) {
    const MSG = {
      quota_hour: 'С этой сети сегодня уже много проверок по фото. Попробуйте через час, а пока средства можно выбрать из базы: это те же вердикты.',
      quota_day: 'На сегодня проверки по фото закончились. Выбор из базы работает без ограничений.',
      catalog: 'Распознавание временно недоступно: не смогли загрузить каталог. Выбор из базы работает.',
      bad_image: 'Этот снимок не подошёл. Попробуйте другой кадр.',
    };
    track('recognition', { outcome: data.error || 'error', seconds });
    photoActions(photoShell(MSG[data.error] || 'Что-то пошло не так с нашей стороны. Попробуйте ещё раз.'),
      data.error !== 'quota_day');
    return;
  }

  const plan = planRecognition(data.result, {
    knownId: (id) => Boolean(id) && Boolean(productById(id)),
    slots: { a: pair.a, b: pair.b },
  });
  track('recognition', {
    outcome: plan.screen,
    found: plan.recognized.join('+'),
    guess: (plan.guess || '').slice(0, 100),
    cost_cents: data.cost_cents ?? null,
    seconds,
  });
  pair.a = plan.slots.a;
  pair.b = plan.slots.b;

  if (plan.screen === 'verdict') { pairSource = 'photo'; goto('#verdict'); return; }
  if (plan.screen === 'not_cosmetic') {
    photoActions(photoShell('На фото не видно косметического средства. Попробуйте снять банку крупнее.'));
    return;
  }
  if (plan.screen === 'quality') {
    photoActions(photoShell(`Переснимите, пожалуйста: ${QUALITY_TEXT[plan.quality] || 'кадр не разобрать'}.`));
    return;
  }
  if (plan.screen === 'candidates') {
    const known = plan.recognized.length ? productById(plan.recognized[0]) : null;
    const s = photoShell(known
      ? `Узнали: ${known.brand} ${known.name}. Какое из этих второе?`
      : 'Не уверены. Какое из этих ваше?');
    const list = el('div', 'plist');
    for (const id of plan.candidates) {
      const p = productById(id);
      if (!p) continue;
      const row = el('button', 'prow');
      row.appendChild(cutTile(p, 'mini'));
      const t = el('div', 'pt');
      t.appendChild(text('div', 'pb', p.brand));
      t.appendChild(text('div', 'pn', p.name));
      row.appendChild(t);
      row.addEventListener('click', () => {
        track('candidate_pick', { picked: p.id });
        pairSource = 'photo';
        if (!pair.a) pair.a = p.id;
        else if (pair.a !== p.id) pair.b = p.id;
        goto(pair.a && pair.b ? '#verdict' : '#home');
      });
      list.appendChild(row);
    }
    s.appendChild(list);
    const none = el('button', 'btn ghost', 'Ничего из этого');
    none.style.marginTop = '12px';
    none.addEventListener('click', () => photoActions(photoShell(
      'Хорошо, не угадали. Выберите средство из базы руками или переснимите кадр.')));
    s.appendChild(none);
    photoActions(s);
    return;
  }
  if (plan.screen === 'one') {
    const p = productById(plan.recognized[0]);
    const s = photoShell(`Узнали: ${p.brand} ${p.name}. Второе средство в кадре не разглядели.`);
    const list = el('div', 'plist');
    const row = el('button', 'prow');
    row.appendChild(cutTile(p, 'mini'));
    const t = el('div', 'pt');
    t.appendChild(text('div', 'pb', p.brand));
    t.appendChild(text('div', 'pn', p.name));
    t.appendChild(text('div', 'pk', 'уже в первом слоте'));
    row.appendChild(t);
    row.disabled = true;
    list.appendChild(row);
    s.appendChild(list);
    const second = el('a', 'btn', 'Выбрать второе из базы');
    second.href = '#picker-b';
    s.appendChild(second);
    const again = el('button', 'btn ghost', 'Снять второе');
    again.addEventListener('click', renderPhoto);
    s.appendChild(again);
    return;
  }
  // Средство не из каталога: экран не тупик, а развилка. Три выхода те же,
  // что в пикере, плюс «переснять» (PRD v3, разделы 2 и 6).
  const guess = plan.guess ? cleanGuess(plan.guess) : '';
  const slot = !pair.a ? 'a' : (!pair.b ? 'b' : 'a');
  const s = photoShell(guess
    ? `Похоже на «${guess}», в каталоге его нет. Состав можно добавить самой, вердикт посчитают те же правила.`
    : 'Этого средства мы пока не узнали. Это честное «не знаю», а не ошибка: состав можно добавить самой.');
  const exits = el('div', 'exits');
  exits.appendChild(text('div', 'flabel', 'три способа добавить состав'));
  const byName = el('a', 'btn', 'Найти состав по названию');
  byName.href = `#lookup-${slot}`;
  // Прочитанное с этикетки название уходит в поиск как есть: перепечатывать
  // его человеку незачем.
  byName.addEventListener('click', () => { lookupPrefill = guess; });
  exits.appendChild(byName);
  const shot = el('a', 'btn ghost', 'Снять оборот с составом');
  shot.href = `#back-${slot}`;
  exits.appendChild(shot);
  const paste = el('a', 'btn ghost', 'Вставить состав');
  paste.href = `#paste-${slot}`;
  exits.appendChild(paste);
  s.appendChild(exits);
  track('unknown_screen', { reason: guess ? 'not_in_catalog' : 'not_recognized', guess: guess.slice(0, 80) });
  photoActions(s);
}

// ---------- роутер на хешах: контент рисуется при входе на экран ----------
function route() {
  const hash = location.hash || '#home';
  if (hash === '#home' || hash === '') renderHome();
  else if (hash === '#picker-a') renderPicker('a');
  else if (hash === '#picker-b') renderPicker('b');
  else if (hash === '#verdict') renderVerdict();
  else if (hash === '#prod-a') renderProduct('a');
  else if (hash === '#prod-b') renderProduct('b');
  else if (hash === '#history') renderHistory();
  else if (hash === '#photo') renderPhoto();
  else if (hash === '#paste-a') renderPaste('a');
  else if (hash === '#paste-b') renderPaste('b');
  else if (hash === '#lookup-a') renderLookup('a');
  else if (hash === '#lookup-b') renderLookup('b');
  else if (hash === '#back-a') renderBack('a');
  else if (hash === '#back-b') renderBack('b');
}

// ---------- старт ----------
async function main() {
  const res = await fetch('../shared/base.json');
  base = await res.json();
  track('open', { first: !readStore(HISTORY_KEY) });

  // пример: пара с находкой (в креме тоже ретинол)
  const example = ['vt-reti-a-reedle-shot', 'madeca-time-reverse'];
  const exampleBtn = $('#home-example');
  if (example.every((id) => productById(id))) {
    exampleBtn.addEventListener('click', () => {
      pair.a = example[0];
      pair.b = example[1];
      pairSource = 'example';
    });
  } else {
    // База может приехать урезанной фильтром verified: кнопка, которая
    // роняет приложение, хуже отсутствующей кнопки (review F19).
    exampleBtn.remove();
  }

  // Ссылка с парой открывает вердикт сразу, минуя выбор.
  const shared = pairFromAddress();
  if (shared && productById(shared.a) && productById(shared.b)) {
    pair.a = shared.a;
    pair.b = shared.b;
    pairSource = 'link';
    if (!location.hash || location.hash === '#home') location.replace('#verdict');
  } else if (shared) {
    history.replaceState(null, '', location.pathname + location.hash);
  }

  document.body.classList.remove('loading');
  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн подождёт */ });
    // Телефон, который уже открывал сайт, после деплоя выполнил бы старое
    // ядро на новой базе. Один перезаход обновляет обе половины (review F03).
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
}

main().catch((e) => {
  document.body.textContent = 'Не получилось загрузить базу. Обновите страницу.';
  console.error(e);
});

// Сведение списка INCI к активам базы. Чистая функция без сети и без DOM:
// одна и та же обслуживает путь с фото оборота, путь по названию и путь
// «вставить состав руками» (PRD v3, раздел 5).
//
// Принцип: совпадение точное по всему названию компонента после нормализации.
// Частичное совпадение запрещено: «zinc» поймал бы и Zinc Oxide, и Zinc PCA,
// а «betaine» поймал бы Betaine Salicylate (review-2026-09-07.md, F16).

const MAIN_POSITIONS = 8;

// Нормализация имени компонента: регистр, скобки, проценты, хвостовые точки.
// «Aqua (Water)» и «AQUA/WATER/EAU» это одно и то же имя.
export function normalizeName(raw) {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');           // скобочные пояснения
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\d+(?:[.,]\d+)?\s*%/g, ' '); // концентрации
  s = s.replace(/\*+/g, ' ');                 // сноски про органику
  s = s.replace(/[†‡•·]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  return s;
}

// Список состава приходит строкой с запятыми, столбиком или вперемешку.
export function splitInci(input) {
  if (Array.isArray(input)) return input.flatMap((line) => splitInci(line));
  let s = String(input || '');
  // Заголовок списка и хвост «может содержать» это не компоненты.
  // Границы слов в javascript не знают кириллицы, поэтому ищем ключевое
  // слово вместе с двоеточием, а не по границе слова.
  s = s.replace(/^[\s\S]{0,40}?(?:ingredients?|состав|ingr[ée]dients|ingredientes|성분)\s*[:：]/i, '');
  s = s.split(/\bmay contain\b|\+\/-/i)[0];
  // Запятая внутри числа это часть имени: «1,2-Hexanediol» один компонент,
  // а не «1» и «2-Hexanediol».
  // Прячем запятую внутри числа вместо ретроспективной проверки: lookbehind
  // появился в Safari только в 16.4, а до этого модуль не парсится и всё
  // приложение умирает целиком, ещё до первого экрана.
  const KEEP = '\u0000';
  return s
    .replace(/(\d),(\d)/g, `$1${KEEP}$2`)
    .split(/[,\n;·•]+/)
    .map((part) => (part || '').split(KEEP).join(',').trim())
    .filter(Boolean);
}

function buildIndex(base) {
  const byName = new Map();
  for (const a of base.actives || []) {
    for (const name of a.inci || []) {
      const key = normalizeName(name);
      if (key) byName.set(key, a);
    }
    // Составные имена вида «aqua/water/eau» распадаются на части.
  }
  const excipients = new Set((base.excipients || []).map(normalizeName));
  const preservatives = new Set((base.preservatives || []).map(normalizeName));
  const calmGroups = new Set((base.groups || []).filter((g) => g.calm).map((g) => g.id));
  // Группы, где смысл компонента зависит от места в списке: отдушка
  // тридцать второй строкой это след, а не действующий компонент.
  const positionalGroups = new Set((base.groups || []).filter((g) => g.positional).map((g) => g.id));
  return { byName, excipients, preservatives, calmGroups, positionalGroups };
}

// resolveInci(input, base) -> {
//   actives: [{ id, role, position }],  роли по позиции в списке
//   unknown: [строки, которых нет ни в активах, ни во вспомогательных],
//   excipients: [узнанные вспомогательные],
//   components: сколько компонентов разобрано,
//   mainUntil: позиция, до которой активы считаются главными
// }
export function resolveInci(input, base) {
  const { byName, excipients, preservatives, calmGroups, positionalGroups } = buildIndex(base);
  const parts = splitInci(input);

  // Граница между главными и вспомогательными: первые восемь позиций,
  // а если консервант встретился раньше, всё до него.
  let mainUntil = MAIN_POSITIONS;
  for (let i = 0; i < parts.length; i++) {
    if (preservatives.has(normalizeName(parts[i]))) { mainUntil = Math.min(mainUntil, i); break; }
  }

  const actives = [];
  const unknown = [];
  const seenExcipients = [];
  const seen = new Set();

  parts.forEach((part, index) => {
    const key = normalizeName(part);
    if (!key) return;
    const active = byName.get(key);
    // Лимонная кислота в первых позициях это эксфолиант, ниже регулятор pH.
    const positional = active && active.position_max !== undefined && index >= active.position_max;
    if (active && !positional) {
      if (seen.has(active.id)) return;
      seen.add(active.id);
      // Позиция решает роль у спокойных компонентов: увлажнитель в хвосте
      // состава дублем крема не делает. Активный компонент главный всегда:
      // ретинол на двенадцатой позиции это всё равно ретинол, и правило
      // «ретиноид поверх ретиноида» должно сработать.
      const byPosition = calmGroups.has(active.group) || positionalGroups.has(active.group);
      const role = !byPosition || index < mainUntil ? 'main' : 'support';
      actives.push({ id: active.id, role, position: index });
      return;
    }
    if (excipients.has(key) || positional) { seenExcipients.push(part); return; }
    // Составные имена вида «Aqua/Water» это одно и то же вещество,
    // записанное на двух языках. Разбираем их, только если КАЖДАЯ часть
    // известна как вспомогательный компонент: иначе «Caprylic/Capric
    // Triglyceride» развалится на два выдуманных имени.
    if (key.includes('/')) {
      const parts2 = key.split('/').map((x) => x.trim()).filter(Boolean);
      if (parts2.length > 1 && parts2.every((x) => excipients.has(x))) {
        seenExcipients.push(part);
        return;
      }
    }
    unknown.push(part);
  });

  return { actives, unknown, excipients: seenExcipients, components: parts.length, mainUntil };
}

// Состав на банке всегда напечатан на латинице: это международный формат
// INCI. Если человек вставил русский перевод с сайта магазина, ни один
// компонент не сведётся, и сказать про это надо прямо, а не обвинять его
// в том, что он «скопировал не весь список».
export function looksTranslated(input) {
  const text = Array.isArray(input) ? input.join(' ') : String(input || '');
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cyrillic > 0 && cyrillic > latin;
}

// Временный продукт для verdict(): тот же объект, что у продукта каталога.
export function productFromInci(input, base, meta = {}) {
  const resolved = resolveInci(input, base);
  return {
    product: {
      id: meta.id || null,
      brand: meta.brand || '',
      name: meta.name || 'Средство не из каталога',
      kind: meta.kind || '',
      actives: resolved.actives.map(({ id, role }) => ({ id, role })),
      // Сырой состав нужен очереди пополнения базы: там ждут строки INCI,
      // а не наши id активов, иначе запись бесполезна для вычитки.
      inci_raw: splitInci(input),
      // Нераспознанное едет с продуктом до экрана вердикта: иначе экран
      // вставки честно говорит про пятнадцать неузнанных компонентов,
      // а вердикт делает вид, что разобрал состав целиком.
      unknown_raw: resolved.unknown,
      status: 'draft',
      origin: meta.origin || 'manual',
      composition_source: meta.composition_source || { kind: 'manual' },
    },
    resolved,
  };
}

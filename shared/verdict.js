// Ядро вердикта Banka Match. Чистая функция без зависимостей.
// Потребители: PWA (<script type="module">) и Expo (import).
// Контракт описан в PRD-v3-rabochaya-versiya.md, раздел 3.

export const STATE_ORDER = { stop: 3, caution: 2, go: 1 };

export const LEVEL_LABELS = {
  1: 'мнение экспертов',
  2: 'отдельные исследования',
  3: 'метаанализы и обзоры',
  4: 'клинические рекомендации',
};

// Насколько правило адресное: поштучное бьёт групповое, группа бьёт `any`.
function specificity(rule) {
  const kind = (t) => (t === 'any' ? 0 : t.startsWith('group:') ? 1 : 2);
  return kind(rule.a) + kind(rule.b);
}

// Токен правила ('retinol', 'group:retinoids' или 'any') против конкретного актива.
function tokenMatches(token, active) {
  if (token === 'any') return true;
  if (token.startsWith('group:')) return active.group === token.slice(6);
  return active.id === token;
}

// Правило совпадает с парой активов в любом порядке.
function ruleMatches(rule, x, y) {
  return (
    (tokenMatches(rule.a, x) && tokenMatches(rule.b, y)) ||
    (tokenMatches(rule.a, y) && tokenMatches(rule.b, x))
  );
}

// Правило дубля («увлажнение дважды», «ретиноид поверх ретиноида») говорит
// о том, что оба средства решают одну задачу. Это верно, только когда актив
// в обоих продуктах главный: гиалуроновая пятым номером в кислотной сыворотке
// дублем крема не делает (review-2026-09-07.md, F07).
function ruleAllowedForRoles(rule, x, y) {
  if (rule.duplicate) return x.role === 'main' && y.role === 'main';
  // Правило с main_only говорит про дозозависимый компонент: отдушка
  // в первых строках состава это повод для осторожности, отдушка
  // тридцать второй строкой след, и предупреждать о нём значит
  // выдать «с осторожностью» почти на любой реальный состав.
  if (!rule.main_only) return true;
  const ok = (token, active) => token === 'any' || active.role === 'main';
  return tokenMatches(rule.a, x) && tokenMatches(rule.b, y)
    ? ok(rule.a, x) && ok(rule.b, y)
    : ok(rule.a, y) && ok(rule.b, x);
}

// Сколько сторон правила говорят про активную (не спокойную) группу.
// Пара «крем с ретиноидной сывороткой» должна получать заголовок про
// ретиноид, а не «барьерные липиды ничему не мешают»: оба правила верны,
// но полезно второе. Без базы групп считаем 0 и тай-брейк не меняем.
function strength(rule, calmGroups) {
  if (!calmGroups) return 0;
  const one = (token) => {
    if (!token || token === 'any') return 0;
    const group = token.startsWith('group:') ? token.slice(6) : calmGroups.groupOf.get(token);
    if (!group) return 0;
    return calmGroups.calm.has(group) ? 0 : 1;
  };
  return one(rule.a) + one(rule.b);
}

// Детерминированный победитель: строже > про активный компонент >
// про солнце > заметнее > доказаннее > меньший id. Тай-брейк по числу
// чувствительных к солнцу активов ставит заголовок про главный актив пары:
// «ретиноид и санскрин» вместо «идеальной утренней связки» про ниацинамид
// (F05). Заметность разводит одинаково верные заголовки по полезности:
// «санскрин ложится поверх всего» человеку нужнее, чем «ниацинамид
// ни с чем не спорит», хотя оба правда.
function better(a, b) {
  if (STATE_ORDER[a.rule.state] !== STATE_ORDER[b.rule.state]) {
    return STATE_ORDER[a.rule.state] > STATE_ORDER[b.rule.state] ? a : b;
  }
  if (a.strength !== b.strength) return a.strength > b.strength ? a : b;
  if (a.sun.size !== b.sun.size) return a.sun.size > b.sun.size ? a : b;
  const sa = a.rule.salience || 0;
  const sb = b.rule.salience || 0;
  if (sa !== sb) return sa > sb ? a : b;
  if (a.rule.level !== b.rule.level) return a.rule.level > b.rule.level ? a : b;
  return a.rule.id < b.rule.id ? a : b;
}

// Роль актива в продукте: главный или вспомогательный. По умолчанию главный.
function roleOf(entry) {
  if (typeof entry === 'string') return 'main';
  return entry.role === 'support' ? 'support' : 'main';
}

function resolveActives(product, activesById) {
  const known = [];
  const unknown = [];
  for (const entry of product.actives || []) {
    const id = typeof entry === 'string' ? entry : entry.id;
    const active = activesById.get(id);
    if (active) known.push({ ...active, role: roleOf(entry) });
    else unknown.push(id);
  }
  return { known, unknown };
}

function pairKey(x, y) {
  return x.id < y.id ? `${x.id}|${y.id}` : `${y.id}|${x.id}`;
}

// verdict(productA, productB, base) -> {
//   state: 'stop' | 'caution' | 'go' | 'none' | 'unknown',
//   winner: правило-победитель или null,
//   fired: все сработавшие правила (победитель первым, дальше по строгости),
//   unknownActives: активы, которых нет в базе,
//   uncovered: комбинации активов без единого правила, по одной на пару,
//   partial: вердикт вынесен по неполным данным,
//   spfNote: нужна приписка про солнце,
//   spfLast: в паре есть санскрин, приписка меняется на «последним слоем»,
//   same: оба слота заняты одним продуктом
// }
export function verdict(productA, productB, base) {
  const activesById = new Map(base.actives.map((a) => [a.id, a]));
  const calmGroups = base.groups
    ? {
        calm: new Set(base.groups.filter((g) => g.calm).map((g) => g.id)),
        groupOf: new Map(base.actives.map((a) => [a.id, a.group])),
      }
    : null;
  const A = resolveActives(productA, activesById);
  const B = resolveActives(productB, activesById);
  const unknownActives = [...A.unknown, ...B.unknown];
  const allKnown = [...A.known, ...B.known];
  const spfLast = allKnown.some((a) => a.group === 'spf');
  // Приписку про солнце гасит санскрин в паре: он и есть ответ на неё.
  const spfNote = !spfLast && allKnown.some((a) => a.sun_sensitive);
  const same = Boolean(productA.id) && productA.id === productB.id;

  // Все активы средства неизвестны: вердикт не выносится.
  if (
    (A.known.length === 0 && A.unknown.length > 0) ||
    (B.known.length === 0 && B.unknown.length > 0)
  ) {
    return {
      state: 'unknown',
      winner: null,
      fired: [],
      unknownActives,
      uncovered: [],
      partial: true,
      spfNote,
      spfLast,
      same,
    };
  }

  const firedById = new Map();
  // Комбинации активов, по которым правила нет вообще. Считаем их отдельно:
  // без этого широкое групповое правило выдаёт уверенное «можно вместе»
  // за всю пару, хотя про часть активов оно молчит. Ровно так ретинол
  // с витамином C однажды получил «go» по правилу про спокойную базу.
  const uncoveredByKey = new Map();
  for (const x of A.known) {
    for (const y of B.known) {
      const matches = base.rules.filter((r) => ruleMatches(r, x, y));
      if (matches.length === 0) {
        // Актив сам с собой сравнивать нечего: это не пробел в знании.
        if (x.id !== y.id) uncoveredByKey.set(pairKey(x, y), [x, y]);
        continue;
      }
      // Правило дубля при вспомогательной роли молчит, но пробелом это
      // не считается: знание о паре у базы есть.
      const eligible = matches.filter((r) => ruleAllowedForRoles(r, x, y));
      if (eligible.length === 0) continue;
      // Для одной пары активов действует только самый адресный слой правил.
      const top = Math.max(...eligible.map(specificity));
      for (const r of eligible) {
        if (specificity(r) !== top) continue;
        const rec = firedById.get(r.id) || { rule: r, sun: new Set(), strength: strength(r, calmGroups) };
        if (x.sun_sensitive) rec.sun.add(x.id);
        if (y.sun_sensitive) rec.sun.add(y.id);
        firedById.set(r.id, rec);
      }
    }
  }

  const uncovered = [...uncoveredByKey.values()];
  const records = [...firedById.values()];

  if (records.length === 0) {
    return {
      state: 'none',
      winner: null,
      fired: [],
      unknownActives,
      uncovered,
      partial: unknownActives.length > 0 || uncovered.length > 0,
      spfNote,
      spfLast,
      same,
    };
  }

  const winner = records.reduce(better);
  const rest = records
    .filter((r) => r.rule.id !== winner.rule.id)
    .sort((a, b) => (better(a, b) === a ? -1 : 1))
    .map((r) => r.rule);

  return {
    state: winner.rule.state,
    winner: winner.rule,
    fired: [winner.rule, ...rest],
    unknownActives,
    uncovered,
    // Вердикт неполный, если часть активов не покрыта правилами или
    // вообще не найдена в базе. Экран обязан сказать об этом словами:
    // молчаливое «можно вместе» по половине состава хуже, чем «не знаю».
    partial: unknownActives.length > 0 || uncovered.length > 0,
    spfNote,
    spfLast,
    same,
  };
}

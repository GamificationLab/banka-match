// Разбор ответа воркера распознавания. Чистая функция без DOM и без сети:
// весь выбор экрана и слотов решается здесь и тестируется фикстурами.
// Контракт: PRD-v3-rabochaya-versiya.md, раздел 2; сценарии cjm-raspoznavanie.md.

export const CONFIDENT = 0.8; // принимаем молча
export const CANDIDATE = 0.45; // показываем карточками на выбор

// Догадка модели это свободный текст с этикетки, а не наши слова.
// На экран он попадает обрезанным и очищенным: наклейка на банке
// не должна говорить от имени приложения (review F24).
export function cleanGuess(value, limit = 60) {
  return String(value || '')
    .replace(/[^\p{L}\p{N} .\-+%]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .trim();
}

function guessOf(item) {
  return cleanGuess([item.brand_guess, item.name_guess].filter(Boolean).join(' '));
}

// planRecognition(result, { knownId, slots, limit })
//   result  ответ воркера (поле result), уже проверенный на воркере
//   knownId (id) => true, если продукт есть в каталоге клиента
//   slots   текущее состояние пары { a, b }: выбранное руками не затираем
// ->
//   { screen, slots, candidates, guess, quality, recognized }
//   screen: 'not_cosmetic' | 'quality' | 'verdict' | 'one' | 'candidates' | 'unknown'
export function planRecognition(result, { knownId, slots = { a: null, b: null }, limit = 2 } = {}) {
  const quality = result?.photo_quality && result.photo_quality !== 'ok' ? result.photo_quality : null;
  const next = { a: slots.a || null, b: slots.b || null };

  if (result && result.is_cosmetic === false) {
    return { screen: 'not_cosmetic', slots: next, candidates: [], guess: null, quality, recognized: [] };
  }

  const items = (result?.products || [])
    .map((p) => ({
      id: knownId(p.catalog_id) ? p.catalog_id : '',
      confidence: Number.isFinite(p.confidence) ? Math.min(1, Math.max(0, p.confidence)) : 0,
      guess: guessOf(p),
      candidates: (p.candidates || []).filter((c) => knownId(c)),
    }))
    // Средство из каталога и внятная догадка это разные полезные ответы,
    // пустой элемент не нужен ни там ни там.
    .filter((p) => p.id || p.guess || p.candidates.length);

  // Сначала уверенность, потом срез: иначе банка с заднего плана,
  // названная моделью первой, вытесняет настоящее второе средство (F11).
  items.sort((x, y) => y.confidence - x.confidence);
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (item.id && seen.has(item.id)) continue;
    if (item.id) seen.add(item.id);
    unique.push(item);
    if (unique.length >= limit) break;
  }

  const confident = unique.filter((p) => p.id && p.confidence >= CONFIDENT);
  const rest = unique.filter((p) => !confident.includes(p));

  // Узнанное встаёт в первый пустой слот. Выбранное руками не затираем (F10).
  const recognized = [];
  for (const p of confident) {
    if (next.a === p.id || next.b === p.id) continue;
    if (!next.a) next.a = p.id;
    else if (!next.b) next.b = p.id;
    else break;
    recognized.push(p.id);
  }

  if (next.a && next.b) {
    return { screen: 'verdict', slots: next, candidates: [], guess: null, quality, recognized };
  }

  // Средняя уверенность это не «не знаю»: показываем карточками (F15).
  const candidates = [];
  for (const p of rest) {
    if (p.id && p.confidence >= CANDIDATE) candidates.push(p.id);
    for (const c of p.candidates) candidates.push(c);
  }
  const uniqueCandidates = [...new Set(candidates)].filter((id) => id !== next.a && id !== next.b).slice(0, 3);
  const guess = rest.map((p) => p.guess).find(Boolean) || null;

  if (uniqueCandidates.length) {
    return { screen: 'candidates', slots: next, candidates: uniqueCandidates, guess, quality, recognized };
  }
  if (recognized.length) {
    return { screen: 'one', slots: next, candidates: [], guess, quality, recognized };
  }
  if (quality) {
    return { screen: 'quality', slots: next, candidates: [], guess, quality, recognized };
  }
  return { screen: 'unknown', slots: next, candidates: [], guess, quality, recognized };
}

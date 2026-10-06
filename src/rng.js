/**
 * rng.js — детерминированный генератор случайных чисел.
 *
 * Ключевое требование обучающего проекта: один и тот же сценарий с тем же
 * seed всегда даёт одну и ту же «историю эксперимента». Иначе ученик не
 * сможет ни повторить свой разбор, ни обсудить результат с коллегой.
 */

/** Стабильный 32-битный хеш строки (FNV-1a) — для выбора варианта по id. */
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — быстрый ГПСЧ с периодом 2^32, качества достаточно для симуляции. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Нормальное распределение через Бокс–Мюллера (кэш второго значения). */
export function makeNormal(rand) {
  let spare = null;
  return function normal(mean = 0, sd = 1) {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return mean + sd * v;
    }
    let u;
    let v;
    let s;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return mean + sd * u * mul;
  };
}

/** Логнормальное распределение — хорошо моделирует чеки (длинный хвост). */
export function makeLogNormal(rand, normal) {
  return function logNormal(mu, sigma) {
    return Math.exp(normal(mu, sigma));
  };
}

/**
 * Детерминированное назначение варианта по идентификатору пользователя.
 * Хешируем, а не считаем по счётчику: иначе при перезагрузке / пагинации
 * пользователь «прыгает» между вариантами и расчёт становится бессмысленным.
 */
export function assignVariant(userId, shareB = 0.5) {
  return hash32(userId) / 4294967296 < shareB ? 'B' : 'A';
}
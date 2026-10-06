/**
 * stats.js — статистическое ядро симулятора.
 *
 * Реализовано с нуля без внешних зависимостей, чтобы:
 *  - результат можно было проверить и понять построчно;
 *  - эталонные значения считались независимой реализацией (tools/reference.py).
 *
 * Точность: ~1e-12 (обычная арифметика double).
 * Тесты: tests.html
 */

// ============================================================ гамма / бета

const TINY = 1e-300;
const EPS = 3e-16;
const ITMAX = 500;

function logGamma(x) {
  // Lanczos, g = 7, n = 9
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = g[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Регулярная аппроксимация P(a, x): нижняя неполная гамма / Γ(a). */
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < ITMAX; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  return 1 - gammaQ(a, x);
}

/** Верхняя неполная гамма Q(a, x) = 1 − P(a, x), нормированная на Γ(a). */
function gammaQ(a, x) {
  if (x < 0 || a <= 0) throw new RangeError('gammaQ: нужны a > 0 и x >= 0');
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaP(a, x);

  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Непрерывная дробь для неполной беты-функции (NR betacf). */
function betaCF(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Нормированная неполная бета-функция I_x(a, b). */
export function betaInc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCF(a, b, x)) / a;
  return 1 - (bt * betaCF(b, a, 1 - x)) / b;
}

// ============================================================ нормальное

/**
 * Φ(x) — функция распределения стандартного нормального.
 * Связь с неполной гамма-функцией: Q(1/2, x²/2) = erfc(|x|/√2), поэтому
 * Φ(x) = 1 − ½·erfc(|x|/√2) при x ≥ 0 и ½·erfc(|x|/√2) при x < 0.
 */
export function normCdf(x) {
  const tail = 0.5 * gammaQ(0.5, (x * x) / 2);
  return x >= 0 ? 1 - tail : tail;
}

/** Плотность стандартного нормального. */
export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Φ⁻¹(p) — обратная функция. Бисекция по 0.5*normCdf: медленно, зато
 * гарантированно согласованно с normCdf и точна до машинного нуля.
 */
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (normCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Двухсторонний p-value для z. */
export function twoSidedP(z) {
  return Math.max(0, Math.min(1, 2 * (1 - normCdf(Math.abs(z)))));
}

// ============================================================ доли (конверсии)

/**
 * Двухдольный z-тест для долей (конверсий).
 * @param {number} xa конверсии в A
 * @param {number} na наблюдения в A
 * @param {number} xb конверсии в B
 * @param {number} nb наблюдения в B
 * @param {number} alpha уровень значимости (0.05 по умолчанию)
 */
export function twoProportionZTest(xa, na, xb, nb, alpha = 0.05) {
  const pa = xa / na;
  const pb = xb / nb;
  const diff = pb - pa;

  // SE для теста — пул («общая истинная доля под H0»)
  const ppool = (xa + xb) / (na + nb);
  const sePooled = Math.sqrt(ppool * (1 - ppool) * (1 / na + 1 / nb));
  const z = sePooled === 0 ? 0 : diff / sePooled;

  // SE для доверительного интервала — независимый (оценки различаются)
  const seDiff = Math.sqrt((pa * (1 - pa)) / na + (pb * (1 - pb)) / nb);
  const zCrit = normInv(1 - alpha / 2);

  const pValue = twoSidedP(z);
  const ci = [diff - zCrit * seDiff, diff + zCrit * seDiff];

  // Минимальный детектируемый эффект при текущем размере выборки
  const mdeAbs = (zCrit + normInv(0.8)) * seDiff;

  return {
    pa,
    pb,
    diff,
    relLift: pa === 0 ? NaN : diff / pa,
    sePooled,
    seDiff,
    z,
    pValue,
    ci,
    ciRel: [ci[0] / pa, ci[1] / pa],
    mdeAbs,
    mdeRel: mdeAbs / pa,
    significant: pValue < alpha,
  };
}

// ============================================================ средние (ARPU, сумма чека)

/** t-распределение Стьюдента: CDF через неполную бету-функцию. */
export function studentTCdf(t, df) {
  const x = df / (df + t * t);
  const half = 0.5 * betaInc(df / 2, 0.5, x);
  return t > 0 ? 1 - half : half;
}

/** Обратная функция Стьюдента для верхнего хвоста (бисекция). */
export function studentTInv(p, df) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -400;
  let hi = 400;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * t-тест Уэлча по сводным статистикам (среднее, sd, n).
 * Дисперсии и размеры выборок не предполагаются равными.
 * Экономит память: симулятор не хранит сырые массивы чеков.
 */
export function welchFromStats(sa, sb, alpha = 0.05) {
  const { meanA: ma, sdA, nA: na, meanB: mb, sdB, nB: nb } = { ...sa, ...sb };
  const va = (sdA * sdA) / na;
  const vb = (sdB * sdB) / nb;
  const diff = mb - ma;
  const se = Math.sqrt(va + vb);
  const t = se === 0 ? 0 : diff / se;
  const df = (va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1));
  const pValue = Math.max(0, Math.min(1, 2 * studentTCdf(-Math.abs(t), df)));
  const tCrit = studentTInv(1 - alpha / 2, df);
  const ci = [diff - tCrit * se, diff + tCrit * se];
  const relCi = ma === 0 ? [NaN, NaN] : [ci[0] / ma, ci[1] / ma];

  return {
    meanA: ma,
    meanB: mb,
    sdA,
    sdB,
    nA: na,
    nB: nb,
    diff,
    relLift: ma === 0 ? NaN : diff / ma,
    se,
    t,
    df,
    pValue,
    ci,
    ciRel: relCi,
    significant: pValue < alpha,
  };
}

/**
 * Выборочное стандартное отклонение из первого и второго моментов.
 * Используется несмещённая дисперсия (делитель n−1) — как в тесте Уэлча.
 * Избыточная точность вычислений требует смещённой оценки m2, поэтому
 * сначала стабилизируем дисперсию через вычитание среднего.
 */
export function sdFromMoments(sum, sumSq, n) {
  if (n < 2) return 0;
  const mean = sum / n;
  const m2 = sumSq / n - mean * mean;
  return Math.sqrt(Math.max(0, (m2 * n) / (n - 1)));
}

/**
 * t-тест Уэлча для средних (удобная обёртка для массивов).
 * @param {number[]} a массив значений A
 * @param {number[]} b массив значений B
 */
export function welchTTest(a, b, alpha = 0.05) {
  const summary = (xs) => {
    const n = xs.length;
    let sum = 0;
    let sumSq = 0;
    for (const v of xs) {
      sum += v;
      sumSq += v * v;
    }
    return { mean: sum / n, sd: sdFromMoments(sum, sumSq, n), n };
  };
  const ra = summary(a);
  const rb = summary(b);
  return welchFromStats(
    { meanA: ra.mean, sdA: ra.sd, nA: ra.n },
    { meanB: rb.mean, sdB: rb.sd, nB: rb.n },
    alpha
  );
}

// ============================================================ хи-квадрат

/** P(X > x) для χ² с df степенями свободы. */
export function chi2SF(x, df) {
  return gammaQ(df / 2, x / 2);
}

/**
 * Sample Ratio Mismatch — проверка, что трафик разделился как задумано.
 * Ожидаем: na из n по доле 0.5.
 * @returns {{chi2:number, df:number, pValue:number, expectedA:number, srm:boolean}}
 */
export function srmCheck(na, nb, expectedShare = 0.5, alpha = 0.001) {
  const n = na + nb;
  const expA = n * expectedShare;
  const expB = n * (1 - expectedShare);
  const chi2 = (na - expA) ** 2 / expA + (nb - expB) ** 2 / expB;
  const pValue = chi2SF(chi2, 1);
  // порог 0.001: при 1000 экспериментах ложное срабатывание допустимо
  return { chi2, df: 1, pValue, expectedA: expA, srm: pValue < alpha };
}

// ============================================================ MDE / мощность / выборка

/** z-критический для одностороннего/двустороннего уровня. */
export function zCritical(alpha = 0.05) {
  return normInv(1 - alpha / 2);
}

/**
 * Размер выборки на вариант для относительного MDE по доле.
 * Стандартная формулаFleiss для двух пропорций.
 * @param {number} baseline базовая конверсия (доля 0..1)
 * @param {number} mdeRel минимальный детектируемый относительный эффект (0.1 = +10%)
 */
export function sampleSizeProportion(baseline, mdeRel, power = 0.8, alpha = 0.05) {
  const p1 = baseline;
  const p2 = baseline * (1 + mdeRel);
  if (p1 === p2) return Infinity;
  const za = zCritical(alpha);
  const zb = normInv(power);
  const pbar = (p1 + p2) / 2;
  const num =
    (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  return Math.ceil(num / (p2 - p1) ** 2);
}

/** Обратная задача: MDE при известном размере выборки. */
export function mdeForProportion(baseline, n, power = 0.8, alpha = 0.05) {
  // Решаем численно: sampleSizeProportion убывает по |mde|
  let lo = 1e-6;
  let hi = 5;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (sampleSizeProportion(baseline, mid, power, alpha) > n) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Достижимая мощность при заданных baseline, относительном MDE и размере выборки.
 *
 *   power = Φ( |δ|/SE_alt − z_α · SE_null/SE_alt )
 *
 * SE_null считается на пулевой доле (H0), SE_alt — на фактических долях.
 * @param {number} baseline базовая доля
 * @param {number} mdeRel относительный MDE (может быть отрицательным)
 * @param {number} n размер выборки НА ВАРИАНТ
 */
export function powerForProportion(baseline, mdeRel, n, alpha = 0.05) {
  const p1 = baseline;
  const p2 = baseline * (1 + mdeRel);
  if (n <= 0 || p1 === p2) return 0;
  const za = zCritical(alpha);
  const pbar = (p1 + p2) / 2;
  const seNull = Math.sqrt(pbar * (1 - pbar) * (2 / n));
  const seAlt = Math.sqrt((p1 * (1 - p1)) / n + (p2 * (1 - p2)) / n);
  const nonCentrality = Math.abs(p2 - p1) / seAlt;
  const power = normCdf(nonCentrality - za * (seNull / seAlt));
  return Math.max(0, Math.min(1, power));
}

/** Процентное изменение со знаком. */
export function relPct(x) {
  return x * 100;
}

/** Сколько дней нужно при таком трафике. */
export function durationDays(samplesTotalPerVariant, visitorsPerDay) {
  return Math.ceil(samplesTotalPerVariant / visitorsPerDay);
}

/** Человекочитаемый p-value. */
export function formatP(p) {
  if (p < 0.0001) return '< 0.0001';
  return p.toFixed(4);
}

/** p-value вместе со знаком сравнения: «< 0.0001» или «= 0.0421». */
export function formatPExpr(p) {
  if (p < 0.0001) return '< 0.0001';
  return `= ${p.toFixed(4)}`;
}

/** Словесная интерпретация p-value. */
export function interpretP(p) {
  if (p < 0.01) return 'крайне не вероятно из-за шума';
  if (p < 0.05) return 'маловероятно из-за шума';
  if (p < 0.2) return 'скорее шум, чем эффект';
  return 'почти наверняка шум';
}
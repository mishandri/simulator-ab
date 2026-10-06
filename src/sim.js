/**
 * sim.js — движок симуляции эксперимента.
 *
 * Считает «правду» по дням, но наружу отдаёт только данные, которые увидел бы
 * аналитик. Никакого доступа к параметрам эффекта из UI быть не должно —
 * иначе ученик подсмотрит ответ вместо того, чтобы получить его статистикой.
 */

import { mulberry32, makeNormal, makeLogNormal, assignVariant } from './rng.js';

/** ГПСЧ нормального распределения на основе переданного потока. */
function makeStdNormal(rand) {
  return makeNormal(rand);
}

/**
 * Множитель эффекта новизны: в первые дни эффект сильнее и затухает.
 * @param {number} day номер дня (0-based)
 * @param {number} strength насколько эффект сильнее в первый день (0..1)
 * @param {number} decayDays за сколько дней эффект приходит к норме
 */
export function noveltyFactor(day, strength, decayDays = 3) {
  if (strength <= 0) return 1;
  return 1 + strength * Math.exp((-3 * day) / decayDays);
}

/** Коэффициент дня недели: по выходным трафик выше, конверсия ниже. */
const WEEKDAY_FACTOR = [1.12, 0.94, 0.97, 1.0, 1.03, 1.1, 1.06]; // вс..сб
const WEEKDAY_CONV_FACTOR = [0.94, 1.03, 1.03, 1.04, 1.02, 0.93, 0.9];

/**
 * Генерирует наблюдения за один день.
 * Мысленно эксперимент выглядит так: у каждого id есть исход (покупка / чек),
 * а вариант определяется хешем id. Это ровно то, что делает реальный рандомайзер.
 */
function simulateDay({ day, visitors, scenario, rand, normal, logNormal, shareB }) {
  const { baselineConversion: base, baselineCtr, baselineRevenuePerUser: arpu, truth, traps } = scenario;

  const dow = WEEKDAY_FACTOR[(day + 1) % 7];
  const dowConv = WEEKDAY_CONV_FACTOR[(day + 1) % 7];

  // Эффект новизны и «медленный старт» — метрика первых дней завышена/занижена
  const novelty = noveltyFactor(day, truth.novelty, 3);
  const slow = traps.slowStart && day < 2 ? (day === 0 ? 1.25 : 0.9) : 1;

  // P(покупка | клик) в базовой версии: из маржинальной конверсии и CTR
  const condBase = base / baselineCtr;
  // Средняя стоимость покупки в контроле: ARPU / базовая конверсия
  const orderMeanBase = truthRevenueMean(arpu, base);

  const out = {
    day,
    visitors: { A: 0, B: 0 },
    clicks: { A: 0, B: 0 },
    conv: { A: 0, B: 0 },
    revenue: { A: 0, B: 0 },
    revenueSq: { A: 0, B: 0 },
  };

  for (let i = 0; i < visitors; i++) {
    const userId = `u-${day}-${i}`;
    const variant = assignVariant(userId, shareB);

    // Междневный разброс: общий для обеих версий, чтобы не сломать баланс
    const noise = 1 + normal(0, 0.06);
    // В варианте A эффекта нет: множитель усиления здесь всегда 0
    const effect = variant === 'B' ? novelty * slow : 0;

    const pClick = baselineCtr * noise * (1 + (truth.ctrLiftRel ?? 0) * effect);
    const pCond = condBase * dowConv * noise * (1 + truth.condConversionLiftRel * effect);

    out.visitors[variant]++;
    if (rand() < pClick) {
      out.clicks[variant]++;
      if (rand() < pCond) {
        out.conv[variant]++;
        // Чек: логнормальное распределение. Средняя стоимость покупки в контроле
        // восстанавливается из ARPU и базовой конверсии; в варианте B она меняется.
        const orderMean = orderMeanBase * (1 + truth.revenuePerOrder * effect);
        const orderValue = logNormal(Math.log(orderMean), 0.35);
        out.revenue[variant] += orderValue;
        out.revenueSq[variant] += orderValue * orderValue;
      }
    }
  }
  out.trafficFactor = dow;
  return out;
}

/** Средняя стоимость одной покупки в контрольном варианте. */
function truthRevenueMean(arpu, baselineConversion) {
  return arpu / baselineConversion;
}

/**
 * Главная функция: считает весь эксперимент за scenario.durationDays дней.
 * @param {object} scenario
 * @param {object} opts { seed, shareB, days }
 * @returns {{days:Array, total:object, config:object}}
 */
export function runExperiment(scenario, opts = {}) {
  const seed = opts.seed ?? scenario.seed;
  const designedShareB = opts.shareB ?? 0.5;
  // Ловушка SRM: в «сломанном» эксперименте бакетер распределяет трафик иначе,
  // чем предполагал аналитик. Для UI это выглядит как баг, а не как настройка.
  const effectiveShareB = scenario.traps.srm ? scenario.traps.srmShareB : designedShareB;
  const totalDays = opts.days ?? scenario.durationDays;

  // Отдельный поток случайных чисел на день — стабильнее, чем один общий
  const days = [];
  for (let d = 0; d < totalDays; d++) {
    const dayRand = mulberry32((seed + d * 7919) >>> 0);
    const normal = makeStdNormal(dayRand);
    const logNormal = makeLogNormal(dayRand, normal);
    const visitors = Math.round(scenario.trafficPerDay * WEEKDAY_FACTOR[(d + 1) % 7]);
    days.push(
      simulateDay({ day: d, visitors, scenario, rand: dayRand, normal, logNormal, shareB: effectiveShareB })
    );
  }

  const total = aggregate(days);
  return {
    days,
    total,
    config: { seed, designedShareB, effectiveShareB, days: totalDays },
  };
}

/** Сводит дневные данные к общей таблице A/B. */
export function aggregate(days) {
  const t = {
    visitors: { A: 0, B: 0 },
    clicks: { A: 0, B: 0 },
    conv: { A: 0, B: 0 },
    revenue: { A: 0, B: 0 },
    revenueSq: { A: 0, B: 0 },
  };
  for (const d of days) {
    t.visitors.A += d.visitors.A;
    t.visitors.B += d.visitors.B;
    t.clicks.A += d.clicks.A;
    t.clicks.B += d.clicks.B;
    t.conv.A += d.conv.A;
    t.conv.B += d.conv.B;
    t.revenue.A += d.revenue.A;
    t.revenue.B += d.revenue.B;
    t.revenueSq.A += d.revenueSq.A;
    t.revenueSq.B += d.revenueSq.B;
  }
  return t;
}

/** Накопительные данные по дням — для графика. */
export function cumulativeByDay(days) {
  const running = { visitors: { A: 0, B: 0 }, conv: { A: 0, B: 0 } };
  return days.map((d) => {
    running.visitors.A += d.visitors.A;
    running.visitors.B += d.visitors.B;
    running.conv.A += d.conv.A;
    running.conv.B += d.conv.B;
    return {
      day: d.day,
      cumConvA: running.conv.A,
      cumConvB: running.conv.B,
      cumN_A: running.visitors.A,
      cumN_B: running.visitors.B,
      rateA: running.visitors.A ? running.conv.A / running.visitors.A : 0,
      rateB: running.visitors.B ? running.conv.B / running.visitors.B : 0,
    };
  });
}

/**
 * Правдивый ARPU варианта: выручка / трафик. Нужен только для отладочных
 * проверок симулятора — в интерфейсе аналитику такая цифра недоступна.
 */
export function trueArpu(days, variant) {
  const t = aggregate(days);
  return t.revenue[variant] / t.visitors[variant];
}

/**
 * Средний множитель «силы эффекта» по всему эксперименту: среднее от затухания
 * новизны и от «медленного старта», взвешенное по трафику.
 * Нужен, чтобы оценивать, адекватен ли выбранный учеником MDE: заявленный в
 * сценарии эффект действует в первые дни сильнее, чем в среднем за тест.
 */
export function averageEffectFactor(scenario) {
  const { novelty } = scenario.truth;
  const { slowStart } = scenario.traps;
  let sum = 0;
  let wsum = 0;
  for (let d = 0; d < scenario.durationDays; d++) {
    const w = WEEKDAY_FACTOR[(d + 1) % 7];
    const slow = slowStart && d < 2 ? (d === 0 ? 1.25 : 0.9) : 1;
    sum += w * noveltyFactor(d, novelty, 3) * slow;
    wsum += w;
  }
  return sum / wsum;
}

/**
 * Реализовавшееся относительное изменение маржинальной конверсии за тест.
 * Складывается из двух слоёв: изменение доли кликов и изменение вероятности
 * покупки среди кликнувших.
 */
export function realizedConversionLift(scenario) {
  const { ctrLiftRel = 0, condConversionLiftRel } = scenario.truth;
  const effect = averageEffectFactor(scenario);
  return (1 + ctrLiftRel * effect) * (1 + condConversionLiftRel * effect) - 1;
}
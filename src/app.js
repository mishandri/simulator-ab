/**
 * app.js — интерфейс тренажёра: машина шагов, живой дашборд и разбор ошибок.
 *
 * Ключевой принцип: интерфейс никогда не показывает истинный эффект.
 * Ученик получает только то, что видел бы аналитик, и сам решает,
 * достаточно ли данных, чтобы объявлять победителя.
 */

import { SCENARIOS, getScenario, METRICS, GUARDRAIL_DROP } from './scenarios.js';
import { runExperiment, cumulativeByDay, aggregate, realizedConversionLift } from './sim.js';
import {
  twoProportionZTest,
  welchFromStats,
  sdFromMoments,
  srmCheck,
  sampleSizeProportion,
  mdeForProportion,
  powerForProportion,
  durationDays,
  zCritical,
  formatP,
  formatPExpr,
} from './stats.js';

const STEPS = ['Гипотеза', 'Метрика', 'Дизайн', 'Наблюдение', 'Решение', 'Разбор'];
const POWER_TARGET = 0.8;
/**
 * Допуск при оценке мощности. 79.8% и 80% — на практике одно и то же, но без
 * допуска интерфейс показывал «мощность 80.0%» и тут же красное «мощности
 * не хватит». Округление вверх создавало видимое противоречие.
 */
const POWER_TOL = 0.005;

/** Считаем ли тест достаточно мощным. */
function powerOk(p) {
  return p >= POWER_TARGET - POWER_TOL;
}

/** Мощность с точностью, достаточной чтобы не спорить с округлением. */
function powerText(p) {
  return powerOk(p) ? pct(p, 1) : pct(p, 2);
}

/**
 * Срок человеческим языком. При эффектах меньше процента нужный срок исчисляется
 * годами: «4370 дней» читается как ошибка в расчёте, а «12 лет» — как вывод.
 */
function humanDays(d) {
  if (!Number.isFinite(d)) return 'столько, что срок не имеет смысла';
  if (d <= 120) return days(d);
  const months = Math.round((d / 30.44) * 10) / 10;
  if (months < 24) return `около ${months} ${plural(months, ['месяца', 'месяцев', 'месяцев'])}`;
  const years = Math.round((d / 365) * 10) / 10;
  return `около ${years} ${plural(years, ['года', 'лет', 'лет'])}`;
}
/**
 * Минимальный срок теста и шаг его изменения. Срок задаём кратным недели:
 * у трафика и конверсии есть недельная цикличность (в выходные трафик выше,
 * конверсия ниже), поэтому тест на 10 дней хуже, чем на 14, а не просто «меньше».
 */
const WEEK = 7;
const MIN_DAYS = WEEK;
const MAX_DAYS = WEEK * 8;
/**
 * Значения по умолчанию — их же восстанавливает кнопка сброса.
 * MDE = 10% выбран так, чтобы дефолтный дизайн был выполнимым на типовом трафике
 * сценария: при 5% потребовалось бы 84 дня, что превышает максимум ползунка.
 */
const DEFAULT_MDE = 0.1;
const DEFAULT_SHARE = 0.5;
const DEFAULT_ALPHA = 0.05;
const DEFAULT_DAYS = 21;
/** Метрики-кандидаты на роль гвардрейла, если сценарные не подходят. */
const DEFAULT_GUARDRAILS = ['arpu', 'conversion'];
const REVEAL_MS = 260;

/**
 * День, на который «приходит руководитель с вопросом, не выкатим ли мы».
 * Берём примерно треть теста: так предложение всегда застаёт врасплох, но ещё
 * не на финише. Раньше был фиксированный 7-й день — при сроке 7 дней он
 * приходил в самый последний день и ловушка не работала.
 */
function peekDay(total) {
  return Math.max(2, Math.round(total / 3));
}

const state = {
  scenarioId: null,
  step: 0,
  hypothesis: '',
  primary: null,
  mde: 0.05,
  shareB: 0.5,
  alpha: 0.05,
  duration: 21,
  sim: null,
  revealed: 0,
  timer: null,
  speed: REVEAL_MS,
  peekOffered: false,
  stoppedAt: null,
earlySnap: null,
  srmFlagged: false,
  srmStop: false,
  beforeExtend: null,
  extendedDays: 0,
  decision: null,
};

// ============================================================ утилиты

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const pct = (x, digits = 2) => `${(x * 100).toFixed(digits)}%`;
const signed = (x, digits = 2) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;
const num = (x, digits = 0) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const money = (x) => `${x.toFixed(1).replace('.', ',')} ₽`;

/** Русское склонение: plural(21, ['день','дня','дней']) → 'день'. */
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const days = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

function cls(x) {
  return x > 0 ? 'pos' : x < 0 ? 'neg' : 'muted';
}

/** Глагол, согласованный с родом названия метрики: «конверсия упала», «CTR упал». */
const fell = (id) => (METRICS[id]?.gender === 'f' ? 'упала' : 'упал');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Всплывающая подсказка для новичка.
 * `align` — сторона, к которой прижимать карточку у края экрана.
 *
 * Кружок сделан настоящей кнопкой, а не картинкой: иначе он не попадает в
 * дерево доступности, его нельзя нажать с клавиатуры и он не раскрывается
 * по тапу на телефоне. Подсказка связана с кнопкой через aria-describedby,
 * поэтому её читает и скринридер.
 */
let tipSeq = 0;
function tip(title, body, align = '') {
  const id = `tipbody-${++tipSeq}`;
  return `<span class="tip-wrap ${align}">
      <button type="button" class="tip" aria-expanded="false" aria-describedby="${id}"
        aria-label="Пояснение: ${escapeHtml(title)}">?</button>
      <span class="tip-body" id="${id}" role="tooltip"><b>${escapeHtml(title)}.</b> ${body}</span>
    </span>`;
}

/** Словарь подсказок: термин → объяснение. */
const GLOSSARY = {
  mde: {
    title: 'MDE — минимальный детектируемый эффект',
    body: `Наименьшее изменение, ради которого стоит запускать тест. Объявляется <b>до старта</b>
      и превращается в обязательный порог: «изменение меньше заявленного нас не интересует,
      и мы его не заметим». Чем мельче MDE, тем больше данных нужно — объём растёт как 1/MDE²,
      то есть уменьшение порога вдвое стоит примерно вчетверо дороже.`,
  },
  power: {
    title: 'Мощность — вероятность поймать эффект',
    body: `Допустим, эффект ровно такой, как мы ищем. Насколько часто тест его обнаружит?
      80% означает: в 8 случаях из 10 мы действительно увидим изменение, а не шум.
      Низкая мощность — типичная причина ложного вывода «изменений нет».`,
  },
  alpha: {
    title: 'α — уровень значимости',
    body: `Порог допустимой вероятности ошибиться: «считать разницу значимой, если она
      случайно возникла с вероятностью не больше α». При α = 0.05 примерно каждый
      двадцатый «выигранный» тест оказывается ложным.`,
  },
  traffic: {
    title: 'Доля трафика на вариант B',
    body: `Какую часть посетителей видит вариант B. 50/50 — стандарт: оба варианта получают
      максимум данных, тест заканчивается быстрее. Отступление вниз допустимо ради
      безопасности, но замедляет тест.`,
  },
  duration: {
    title: 'Срок теста',
    body: `Сколько дней работает эксперимент. Данных набирается тем больше, чем дольше
      он идёт. Срок кратен неделе, чтобы перекрыть недельную цикличность трафика.
      Останавливать тест досрочно, увидев красивое p-value, — ловушка подглядывания.`,
  },
  guardrail: {
    title: 'Гвардрейл',
    body: `Метрика, которую нельзя сломать: конверсия, стабильность, доля отказов.
      Основная метрика может расти, а гвардрейл падает — и тогда выкатка
      блокируется, какой бы красивый ни был основной результат. Основная и гвардрейл
      обязаны быть <b>разными</b> метриками.`,
  },
  srm: {
    title: 'SRM — несовпадение долей трафика',
    body: `Если реальные доли посетителей разошлись с задуманными (не 50/50, а, скажем,
      42/58), группы собраны из разных людей — и сравнивать метрики бессмысленно.
      Первая проверка в мониторинге, до чтения результатов.`,
  },
  proxy: {
    title: 'Прокси-метрика',
    body: `Показатель рядом с настоящей целью: клики, показы, время на сайте. Растёт легко,
      но может сопровождать падение бизнеса. Решение о выкатке принимают по деньгам,
      прокси — только как сигнал, что стоит копать дальше.`,
  },
  ci: {
    title: 'Доверительный интервал',
    body: `Диапазон, в котором лежит настоящая разница с заданной уверенностью (обычно 95%).
      Интервал пересекает ноль — значит, данные не позволяют отличить эффект от шума.
      Это честнее, чем судить по одной цифре p-value.`,
  },
  peeking: {
    title: 'Подглядывание',
    body: `Проверять результат несколько раз до конца теста. Каждая такая проверка —
      дополнительная попытка поймать шум, и именно она порождает ложные открытия.
      Срок и объём выборки фиксируют заранее, а решение принимают один раз.`,
  },
  timeOnSite: {
    title: 'Почему «Время на сайте» недоступно',
    body: `Метрику нужно моделировать: генерировать время каждого посетителя и считать
      среднее. Без этого подписи в таблице показывали бы данные конверсии, а
      p-value считался бы для долей вместо средних. Честнее не показывать вовсе.`,
  },
};

// ============================================================ статистика по срезу

/** Полный срез эксперимента по первым `days` дням. */
function snapshot(scenario, days) {
  const t = aggregate(days);
  const shareB = t.visitors.A + t.visitors.B === 0 ? 0.5 : t.visitors.B / (t.visitors.A + t.visitors.B);

  const conv = twoProportionZTest(t.conv.A, t.visitors.A, t.conv.B, t.visitors.B, state.alpha);
  const ctr = twoProportionZTest(t.clicks.A, t.visitors.A, t.clicks.B, t.visitors.B, state.alpha);
  const arpu = welchFromStats(
    {
      meanA: t.revenue.A / t.visitors.A,
      sdA: sdFromMoments(t.revenue.A, t.revenueSq.A, t.visitors.A),
      nA: t.visitors.A,
    },
    {
      meanB: t.revenue.B / t.visitors.B,
      sdB: sdFromMoments(t.revenue.B, t.revenueSq.B, t.visitors.B),
      nB: t.visitors.B,
    },
    state.alpha
  );
  const srm = srmCheck(t.visitors.A, t.visitors.B, 1 - state.shareB);

  return { t, conv, ctr, arpu, srm, shareB, n: t.visitors.A + t.visitors.B };
}

/** Результат статистического теста по любой метрике среза. */
function metricResult(metricId, snap) {
  if (metricId === 'arpu') return snap.arpu;
  if (metricId === 'ctr') return snap.ctr;
  return snap.conv;
}

/** Результат по выбранной учеником основной метрике. */
function primaryResult(scenario, snap) {
  return metricResult(state.primary, snap);
}

/**
 * Проверка гвардрейла: главная метрика может расти, но «сломать» гвардрейл нельзя.
 * Порог падения задан явно (GUARDRAIL_DROP), чтобы решение ученика опиралось
 * на зафиксированное правило, а не на интуицию.
 */
function guardrailCheck(scenario, snap) {
  // Гвардрейл не может совпадать с основной метрикой: гвардрейл ограничивает вред,
  // а решение принимается по основной. Иначе правило превращается в абсурд
  // «основная метрика выросла, но нельзя выкатывать, потому что выросла».
  const candidates = [...scenario.guardrails, ...DEFAULT_GUARDRAILS];
  const id = candidates.find((m) => m !== state.primary) ?? 'conversion';
  const res = metricResult(id, snap);
  return {
    id,
    res,
    broken: res.significant && res.relLift <= -GUARDRAIL_DROP,
    warning: !res.significant && res.relLift <= -GUARDRAIL_DROP,
  };
}

/**
 * Однозначная формулировка вывода по p-value.
 *
 * Прежняя формулировка «маловероятно из-за шума» читалась двояко: при
 * p = 0.02 значимость есть, но фраза звучит как «скорее шум».
 */
function verdictText(res, alpha = state.alpha) {
  if (res.significant) {
    return `статистически значимо (p ${formatPExpr(
      res.pValue
    )} < α = ${alpha}): наблюдаемое изменение скорее реальное, чем шум`;
  }
  return `не значимо (p ${formatPExpr(res.pValue)} > α = ${alpha}): на этих данных отличить
    эффект от шума нельзя. Это «не хватило данных», а не «эффекта нет»`;
}

/**
 * Проверка выбора основной метрики. Возвращает описание проблемы или null.
 *
 * Основная метрика — та, по которой выносится решение о выкатке. Поэтому:
 *  - ею не может быть гвардрейл (гвардрейл ограничивает вред, а решение принимают
 *    по основной; иначе правило звучит абсурдно);
 *  - ею не может быть прокси-метрика (движется по своим причинам).
 */
function metricProblem(scenario) {
  const id = state.primary;
  if (!id) return null;
  const label = escapeHtml(METRICS[id].label);

  if (scenario.guardrails.includes(id)) {
    return {
      title: `«${label}» в этом сценарии стоит под гвардрейлом — основной её быть не может`,
      body: `«${label}» у этого продукта стоит под защитой: она нужна, чтобы поймать вред, а не
        чтобы рапортовать об успехе. Выбирая её основной, вы получили правило, которое читается
        абсурдно: «основная метрика выросла, но выкатывать нельзя, потому что выросло то, что
        и так должно было расти». Следовало взять ту, что показывает цену изменения.`,
    };
  }

  if (!scenario.goodPrimary.includes(id)) {
    const proper = scenario.goodPrimary.map((g) => `«${escapeHtml(METRICS[g].label)}»`).join(', ');
    const one = scenario.goodPrimary.length === 1;
    return {
      title: `«${label}» — прокси-метрика, по ней нельзя выносить решение о выкатке`,
      body: `Она двигается по своим причинам и может расти вместе с падением бизнеса. Следовало
        смотреть на ${proper} — ${
        one ? 'она показывает, приносит ли изменение' : 'они показывают, приносят ли изменения'
      } деньги или только активность.`,
    };
  }

  return null;
}

/**
 * Структурное противоречие в выборе метрики — то, что видно из условий
 * задачи, не зная ответа.
 *
 * Единственный такой случай: выбранная основная метрика уже занята под
 * гвардрейл этого сценария. Одна метрика не может одновременно быть и тем,
 * по чему выносят решение, и тем, что ограничивает вред: правило выката
 * становится абсурдным («выросло то, что и так должно было расти»).
 *
 * Обратная ситуация — прокси вместо бизнес-метрики — не разбирается здесь:
 * это спор о постановке вопроса, а не факт, и подсказать ответ заранее
 * значит испортить задачу. Про неё разбор говорит на шаге «Решение».
 */
function metricProblemStructural(scenario) {
  const id = state.primary;
  if (!scenario || !id || !scenario.guardrails.includes(id)) return '';
  const label = escapeHtml(METRICS[id].label);
  return `<div class="note bad"><b>Основная метрика уже занята под гвардрейл.</b>
      «${label}» в этом сценарии защищает продукт от вреда, а решение о выкатке
      принимают по основной метрике. Если взять «${label}» основной, правило
      выката получится таким: «метрика выросла — но выкатывать нельзя, потому что
      выросло то, что и так должно было расти».
      <br><br>Это видно из условий задачи, а не из ответа на неё: вернуться и
      перевыбрать можно, не потратив прогон.</div>
    <div class="row"><button class="primary" id="back-metric-design">
      Вернуться к шагу 2. Метрика</button></div>`;
}

/** Блок ошибки выбора метрики с возвратом на шаг 2. */
function metricProblemHtml(scenario) {
  const problem = metricProblem(scenario);
  if (!problem) return '';
  return `<div class="note bad">
      <b>${problem.title}.</b>
      <div style="margin-top:6px">${problem.body}</div>
      <div class="row">
        <button class="primary" id="back-metric">Вернуться к шагу 2. Метрика</button>
      </div>
    </div>`;
}

/**
 * Открытие подсказки по клику: на тач-экранах и трекпадах наведения нет,
 * а одного наведения мало. Открытая подсказка закрывается кликом по ней,
 * повторным кликом, по Escape или кликом снаружи.
 *
 * Слушатель один и делегированный на контейнер экрана: подсказок на шаге
 * дизайна пять, а раньше обработчик вешался только на первую — остальные
 * кружки молчали. Экран перерисовывается целиком, поэтому вешать обработчик
 * заново после каждого рендера тоже нельзя, повесил бы десяток копий.
 */
function wireTips() {
  if (app.dataset.tipBound) return;
  app.dataset.tipBound = '1';

  app.addEventListener('click', (e) => {
    const btn = e.target.closest('.tip');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = btn.closest('.tip-wrap');
    const isOpen = wrap.classList.contains('open');
    closeTips();
    if (!isOpen) {
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      btn.focus();
    }
  });

  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const wrap = app.querySelector('.tip-wrap.open');
    if (!wrap) return;
    const btn = wrap.querySelector('.tip');
    closeTips();
    if (btn) btn.focus();
  });
}

function closeTips() {
  app.querySelectorAll('.tip-wrap.open').forEach((el) => {
    el.classList.remove('open');
    const b = el.querySelector('.tip');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}

// Клик вне подсказки закрывает её
if (!document.body.dataset.tipBound) {
  document.body.dataset.tipBound = '1';
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.tip-wrap')) closeTips();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTips();
  });
}

/** Сброс прогона: данные, таймер и признаки остановки. Дизайн не трогаем. */
function resetRun() {
  stopTimer();
  state.sim = null;
  state.revealed = 0;
  state.speed = REVEAL_MS;
  state.peekOffered = false;
  state.stoppedAt = null;
  state.earlySnap = null;
  state.srmFlagged = false;
  state.srmStop = false;
  state.beforeExtend = null;
  state.extendedDays = 0;
  state.decision = null;
}

/** Возврат к шагу выбора метрики: прогон сбрасывается, параметры дизайна сохраняются. */
function backToMetric() {
  resetRun();
  state.primary = null;
  state.step = 1;
  render();
}

/**
 * Возврат по степперу. Назад можно уйти только до запуска теста: после старта
 * данные уже набираются, и «откатить» прогон — значит стереть его историю.
 */
function goBackTo(step) {
  // step — индекс в степперере (0 = «Гипотеза»). Главная страница лежит
  // вне шкалы и обозначена -1, поэтому `step >= state.step` идёт первым:
  // иначе клик по текущему шагу сбрасывал бы экран.
  if (step >= state.step) return;

  if (state.sim) {
    const ok = window.confirm(
      'Тест уже запущен, возврат назад сбросит накопленные данные и параметры дизайна. Продолжить?'
    );
    if (!ok) return;
    resetRun();
    state.mde = DEFAULT_MDE;
    state.shareB = DEFAULT_SHARE;
    state.alpha = DEFAULT_ALPHA;
    state.duration = DEFAULT_DAYS;
  }

  if (step < 0) {
    showHome();
    return;
  }
  // Возврат на шаг «Метрика» сбрасывает выбор: иначе он остался бы сделан
  // за пользователя на шаг раньше
  if (step <= 1) state.primary = null;
  state.step = step;
  render();
}

/** Ожидаемое направление эффекта — из текста продуктовой гипотезы. */
function hypothesisDirection() {
  const t = (state.hypothesis || '').toLowerCase();
  const worse = /снизит|упад|уменьш|сократ|потеря|дешев|хуже|разочар/.test(t);
  const better = /выраст|повыс|увелич|улучш|рост|сократ(ится )?конкуренц/.test(t);
  if (worse && !better) return 'в сторону ухудшения';
  return 'в сторону улучшения';
}

/**
 * Пара гипотез для проверки.
 *
 * H0 — нулевая: эффекта нет. Её не нужно формулировать, она подразумевается:
 * «ничего не изменилось». Проверка состоит в том, чтобы H0 отвергнуть.
 * H1 — альтернативная: метрика отличается в ожидаемую сторону. Именно её ученик
 * пишет в тексте гипотезы.
 */
function hypothesisPair(scenario, metricId = null) {
  const direction = hypothesisDirection();
  if (metricId) {
    const metric = METRICS[metricId].label;
    return {
      h0: `${metric} в варианте B не отличается от варианта A (либо отличается не более чем на ±${pct(
        state.mde,
        1
      )} — это и есть объявленный MDE)`,
      h1: `${metric} в варианте B отличается от варианта A, ${direction}`,
    };
  }
  return {
    h0: 'Различия между вариантами A и B по основной метрике нет (или оно не превышает объявленного MDE)',
    h1: `Различие есть: основная метрика в варианте B отличается от A, ${direction}`,
  };
}

/** Панель H0/H1: текст на шаге гипотезы и вывод на шаге решения. */
function hypothesisPanel(scenario, snap = null) {
  const pair = hypothesisPair(scenario, snap ? state.primary : null);

  if (!snap) {
    return `
      <h3>Какую гипотезу вы пишете</h3>
      <div class="hypo-pair">
        <div class="hypo h0">
          <span class="tag">H0 — нулевая</span>
          <p>${pair.h0}</p>
          <div class="b">Её формулировать не нужно: она подразумевается по умолчанию.
          Весь смысл эксперимента — получить данные, чтобы её отвергнуть.</div>
        </div>
        <div class="hypo h1">
          <span class="tag">H1 — альтернативная</span>
          <p>${pair.h1}</p>
          <div class="b">Именно её вы пишете в тексте ниже: что меняем, для кого, какую метрику
          смотрим и в какую сторону ждём эффект. Если <code>H0</code> не отвергли — значит,
          данных не хватило, а не «изменений нет».</div>
        </div>
      </div>`;
  }

  const res = primaryResult(scenario, snap);
  const verdict = res.significant
    ? `<span class="pos">Данные позволяют отвергнуть H0</span> (p ${formatPExpr(res.pValue)} &lt; α = ${state.alpha}).`
    : `<span class="neg">Отвергнуть H0 нельзя</span> (p ${formatPExpr(
        res.pValue
      )} &gt; α = ${state.alpha}). Это не подтверждение нулевой гипотезы, а недостаток данных.`;
  return `
    <h3>Проверяемые гипотезы</h3>
    <div class="hypo-pair">
      <div class="hypo h0"><span class="tag">H0 — нулевая</span><p>${pair.h0}</p></div>
      <div class="hypo h1"><span class="tag">H1 — альтернативная</span><p>${pair.h1}</p></div>
    </div>
    <div class="note ${res.significant ? 'good' : 'warn'}"><b>Вывод по H0:</b> ${verdict}</div>`;
}

// ============================================================ расчёт дизайна

/** Фактическая длительность прогона: после продления она больше запланированной. */
function actualDuration() {
  return state.sim ? state.sim.days.length : state.duration;
}

/**
 * Считает дизайн теста.
 *
 * Важно различать два разных срока:
 *  - срок по объёму данных — сколько нужно набрать данных под заявленный MDE;
 *  - выбранный срок — сколько дней ученик готов держать тест.
 * Мощность имеет смысл считать на выбранном объёме и на типичном эффекте:
 * именно так выясняется, не «слишком ли мелкий» выбранный MDE.
 */
function design() {
  const scenario = getScenario(state.scenarioId);
  const baseline = scenario.baselineConversion;
  const duration = state.duration;
  // Типичный эффект зависит от длительности: эффект новизны сильнее в начале,
  // поэтому на коротком тесте средний эффект выше. После продления теста
  // считаем по фактической длительности, а не по плану
  const trueMde = Math.abs(realizedConversionLift(scenario, actualDuration()));

  const perVariant = {
    A: Math.round(scenario.trafficPerDay * (1 - state.shareB)),
    B: Math.round(scenario.trafficPerDay * state.shareB),
  };
  // На прогнозы отвечает вариант с меньшим трафиком — он набирает данные дольше
  const bottleneck = perVariant.A < perVariant.B ? perVariant.A : perVariant.B;

  const need = sampleSizeProportion(baseline, state.mde, POWER_TARGET, state.alpha);
  const daysForSample = durationDays(need, bottleneck);
  // Срок, кратный неделе и достаточный под заявленный MDE
  const daysRecommended = Math.max(MIN_DAYS, Math.ceil(daysForSample / WEEK) * WEEK);

  // Что действительно наберётся за выбранный срок
  const actualSample = bottleneck * duration;
  // Тот же объём, но при честном 50/50 — с этим сравниваем текущую долю
  const sampleAtHalf = Math.round(scenario.trafficPerDay * 0.5 * duration);
  // Крупнейший MDE, который тест надёжно различает (мощность ровно 80%)
  const mdeAchievable = mdeForProportion(baseline, actualSample, POWER_TARGET, state.alpha);

  /*
   * Сколько дней нужно, чтобы поймать ИМЕННО ТИПИЧНЫЙ эффект с целевой мощностью.
   * Это другой вопрос, чем «сколько нужно под заявленный MDE»: мощность зависит
   * от объёма данных и размера эффекта, а вовсе не от объявленного порога.
   *
   * Считаем напрямую через размер выборки, а не перебором сроков: при эффекте
   * меньше процента перебор упирался бы в потолок и давал «нужно Infinity дней»
   * вместо конкретного числа. sampleSizeProportion решает ровно ту же задачу,
   * что и powerForProportion с обратной стороны.
   */
  const sampleForTrue = sampleSizeProportion(baseline, trueMde, POWER_TARGET, state.alpha);
  // Непрерывный срок: sampleSizeProportion округляет вверх до целого, и при
  // эффекте меньше процента округление давало разброс в десятки тысяч дней.
  // Делим и округляем до кратного неделе один раз, в конце.
  const daysForTruePower = Math.max(WEEK, Math.ceil(sampleForTrue / bottleneck / WEEK) * WEEK);
  const maxSample = bottleneck * MAX_DAYS;
  const powerAtMax = powerForProportion(
    baseline,
    trueMde,
    maxSample,
    state.alpha
  );

  return {
    baseline,
    duration,
    trueMde,
    sampleForTrue,
    perVariant,
    bottleneck,
    need,
    daysForSample,
    daysRecommended,
    daysForTruePower,
    powerAtMax,
    actualSample,
    sampleAtHalf,
    powerAtChosen: powerForProportion(baseline, state.mde, actualSample, state.alpha),
    powerOnTrue: powerForProportion(baseline, trueMde, actualSample, state.alpha),
    mdeAchievable,
    scenario,
  };
}

// ============================================================ рендер каркаса

function render() {
  const steps = STEPS.map((title, i) => {
    const isNow = i === state.step;
    const clsName = isNow ? 'now' : i < state.step ? 'done' : 'todo';
    // Назад пускаем только по пройденным шагам, текущий шаг кликабелен только
    // как индикатор: он и так открыт, клик по нему ничего не меняет
    if (i === state.step) {
      return `<div class="st ${clsName}" aria-current="step">${i + 1}. ${title}</div>`;
    }
    if (i > state.step) {
      return `<div class="st ${clsName}" title="Сначала пройдите предыдущий шаг">${i + 1}. ${title}</div>`;
    }
    const label = state.sim ? 'Вернуться назад сбросит данные теста' : 'Вернуться на этот шаг';
    return `<div class="st ${clsName} back" role="button" tabindex="0" data-step="${i}"
      title="${label}">${i + 1}. ${title}</div>`;
  }).join('');

  app.innerHTML = `<div class="stepper">${steps}</div><div id="screen"></div>`;
  wireStepper();
  renderStep();
}

/** Кликабельные кнопки степпера: возврат на пройденный шаг. */
function wireStepper() {
  app.querySelectorAll('.st.back').forEach((el) => {
    const step = Number(el.dataset.step);
    el.onclick = () => goBackTo(step);
    el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goBackTo(step);
      }
    };
  });
}

function renderStep() {
  const el = $('#screen');
  const fn = [
    screenHypothesis,
    screenMetric,
    screenDesign,
    screenObserve,
    screenDecision,
    screenDebrief,
  ][state.step];
  el.innerHTML = fn();
  afterRender();
}

function afterRender() {
  wireTips();
  if (state.step === 0) wireHypothesis();
  if (state.step === 1) wireMetric();
  if (state.step === 2) wireDesign();
  if (state.step === 3) wireObserve();
  if (state.step === 4) wireDecision();
  if (state.step === 5) wireDebrief();
}

// ============================================================ шаг 0: гипотеза

function screenHypothesis() {
  const scenario = getScenario(state.scenarioId);
  return `
    <div class="card">
      <h2>Шаг 1. Гипотеза</h2>
      <p class="lead">Сформулируйте, что именно хотите проверить и как измерите успех.
      Хорошая гипотеза состоит из четырёх частей: <b>что меняем</b>, <b>для кого</b>,
      <b>какую метрику смотрим</b> и <b>в какую сторону ждём эффект</b>.</p>
      <div class="note">Задание от заказчика: «${escapeHtml(scenario.hypothesis)}»</div>
      <div class="grid2" style="margin-top:6px">
        <div><span class="tag">${escapeHtml(scenario.product)}</span></div>
        <div><span class="tag">трафик ${num(scenario.trafficPerDay)}/день</span>
        <span class="tag">базовая конверсия ${pct(scenario.baselineConversion)}</span></div>
      </div>

      <label for="hyp">Ваша формулировка гипотезы</label>
      ${hypothesisPanel(scenario)}
      <textarea id="hyp" placeholder="Если мы ..., то ..., потому что ...">${escapeHtml(state.hypothesis)}</textarea>
      <div class="row">
        <button class="primary" id="next1">Выбрать метрику →</button>
        <button id="hint1">Подсказка</button>
      </div>
      <div id="hyp-msg"></div>
    </div>`;
}

function checkHypothesis(text) {
  const problems = [];
  const t = text.toLowerCase();
  if (text.trim().length < 25) problems.push('формулировка слишком короткая');
  if (!t.includes('если') && !t.includes('изменим') && !t.includes('заменим')) {
    problems.push('нет условной конструкции «если … то …»');
  }
  const hasMetric = ['конверси', 'выручк', 'arpu', 'ctr', 'кликаб', 'средний чек', 'заказ'].some((w) =>
    t.includes(w)
  );
  if (!hasMetric) problems.push('не названа метрика, по которой оцениваем успех');
  const hasDirection = ['выраст', 'вырастет', 'снизит', 'упад', 'повыс', 'увелич', 'улучш', 'рост', 'сократ'].some(
    (w) => t.includes(w)
  );
  if (!hasDirection) problems.push('не указано, в какую сторону ждём эффект');
  return problems;
}

/**
 * Пример формулировки, собранный под конкретное задание сценария.
 * Раньше он был один на все кейсы и про кнопку оформления — даже когда задание
 * было про порог доставки или баннер, пример не имел отношения к задаче.
 */
function hypothesisExample(scenario) {
  const examples = {
    'checkout-button':
      'Если заменить текст кнопки оформления на более явный, то <b>конверсия в покупку</b> ' +
      'вырастет не менее чем на 5% относительно варианта А, потому что снизится непонимание, ' +
      'что произойдёт после клика',
    'free-shipping':
      'Если поднять порог бесплатной доставки с 2000 до 3000 ₽, то <b>выручка на сессию</b> ' +
      'вырастет не менее чем на 5% относительно варианта А, потому что покупатели станут ' +
      'добирать корзину до порога, а конверсия просядет не более чем на 10%',
    'broken-randomizer':
      'Если поднять баннер наверх, то <b>выручка на сессию</b> вырастет не менее чем на 5% ' +
      'относительно варианта А, потому что заметнее основной объявление. Кликабельность при ' +
      'этом вырастет — но решать будем по выручке, а не по ней',
  };
  return examples[scenario.id] ?? '';
}

function wireHypothesis() {
  const scenario = getScenario(state.scenarioId);
  $('#hint1').onclick = () => {
    $('#hyp-msg').innerHTML = `<div class="note"><b>Как выглядит хорошая формулировка.</b>
      Четыре части: <b>что меняем</b> → <b>какая метрика</b> → <b>в какую сторону и на сколько</b> →
      <b>почему</b>.
      <br><br><i>Пример под это задание:</i><br>
      «${hypothesisExample(scenario)}».</div>`;
  };
  $('#next1').onclick = () => {
    const text = $('#hyp').value.trim();
    state.hypothesis = text;
    const problems = checkHypothesis(text);
    if (problems.length) {
      $('#hyp-msg').innerHTML = `<div class="note warn"><b>Гипотеза пока не готова:</b><ul>` +
        problems.map((p) => `<li>${p}</li>`).join('') + `</ul>Допишите и попробуйте снова — это
        влияет на то, сможете ли вы потом оценить результат.` + `</div>`;
      return;
    }
    state.step = 1;
    render();
  };
}

// ============================================================ шаг 1: метрика

function screenMetric() {
  const scenario = getScenario(state.scenarioId);
  // Гвардрейлы намеренно не раскрываем: какие метрики команда держит под защитой,
  // решающий узнаёт при согласовании дизайна. Ошибку в выборе разбираем позже —
  // на шаге решения, вместе с возможностью вернуться и исправить.
  const opts = Object.values(METRICS)
    .map((m) => {
      // Не смоделированную метрику нельзя выбрать: иначе под её названием
      // оказались бы данные другой метрики
      if (m.simulated === false) {
        return `
      <label class="opt off" title="${escapeHtml(m.unavailable ?? '')}">
        <input type="radio" name="primary" value="${m.id}" disabled>
        <span>
          <span class="t">${escapeHtml(m.label)}<span class="tag off">недоступна</span></span>
          <span class="d">${escapeHtml(m.unavailable ?? m.hint)}</span>
        </span>
      </label>`;
      }
      return `
      <label class="opt ${state.primary === m.id ? 'sel' : ''}">
        <input type="radio" name="primary" value="${m.id}" ${state.primary === m.id ? 'checked' : ''}>
        <span>
          <span class="t">${escapeHtml(m.label)}</span>
          <span class="d">${escapeHtml(m.hint)}</span>
        </span>
      </label>`;
    })
    .join('');

  return `
    <div class="card">
      <h2>Шаг 2. Метрика</h2>
      <p class="lead">Выберите <b>основную метрику</b> — ту, по которой вы примете решение о выкатке.
      Всё остальное — гвардрейлы: их нельзя сломать, даже если основная метрика растёт.</p>
      <div class="note">Роль метрики — основная или гвардрейл — команда решает <b>до запуска</b>,
      и это решение нигде не подписано. Ориентир для выбора — задайте себе три вопроса:</div>
      <div class="hypo-pair compact">
        <div class="hypo">
          <span class="tag">1. Про деньги?</span>
          <p>Основная метрика должна отвечать на вопрос «стало ли лучше в деньгах,
          в заказах или в удержании», а не «стало ли активнее».</p>
        </div>
        <div class="hypo">
          <span class="tag">2. Кто целевой?</span>
          <p>Если метрика растёт вместе с ценой эксперимента — клики, показы, время на сайте —
          она прокси: её рост не гарантирует пользы и может сопровождать падение бизнеса.</p>
        </div>
        <div class="hypo">
          <span class="tag">3. Что защищаем?</span>
          <p>Всё, что нельзя сломать, — в гвардрейлы: конверсию, стабильность, отказы.
          Основная и гвардрейл обязаны быть <b>разными</b> метриками, иначе правило выката
          теряет смысл.</p>
        </div>
        <div class="hypo">
          <span class="tag">4. Что покажет дизайн?</span>
          <p>Под выбранную метрику считается MDE и мощность. Слишком тонкая метрика может
          потребовать трафика, которого у продукта нет.</p>
        </div>
      </div>
      <div class="options">${opts}</div>
      <p class="muted" style="font-size:13px">Под основной метрикой считается то, что
      напрямую отвечает на вопрос «принесло ли изменение пользу». Всё, что нельзя сломать,
      уходит в гвардрейлы.${tip(GLOSSARY.guardrail.title, GLOSSARY.guardrail.body)}
      ${tip(GLOSSARY.proxy.title, GLOSSARY.proxy.body)}</p>
      <div class="row">
        <button class="primary" id="next2">Спроектировать тест →</button>
      </div>
      <div id="metric-msg"></div>
      <p class="muted" style="font-size:13px">Продукт: ${escapeHtml(scenario.product)} ·
      гипотеза: «${escapeHtml(state.hypothesis)}»</p>
    </div>`;
}

function wireMetric() {
  document.querySelectorAll('input[name=primary]').forEach((el) => {
    el.onchange = () => {
      state.primary = el.value;
      renderStep();
    };
  });
  $('#next2').onclick = () => {
    if (!state.primary) {
      $('#metric-msg').innerHTML = '<div class="note warn">Сначала выберите метрику.</div>';
      return;
    }
    state.step = 2;
    render();
  };
}

// ============================================================ шаг 2: дизайн

/**
 * Подсказка под ползунком MDE: куда двигать и почему.
 * Ориентир — не «правильный ответ», а калибровка теста: крупнейший эффект,
 * который этот объём данных различает с мощностью 80%.
 */
function mdeHint(d) {
  const recommended = d.mdeAchievable;
  const gap = Math.abs(state.mde - recommended) / recommended;

  if (gap <= 0.15) {
    return `<div class="hint ok"><b>✓ Откалибровано.</b> Ваш MDE примерно совпадает с тем, что тест
      надёжно различает при мощности ${pct(POWER_TARGET, 0)} — это ${pct(recommended, 1)}.
      Двигать ползунок дальше не нужно.</div>`;
  }

  if (state.mde < recommended) {
    return `<div class="hint up"><b>↑ Увеличьте до ≈${pct(recommended, 1)}.</b>
      Сейчас под MDE ${pct(state.mde, 1)} нужно ${num(d.need)} наблюдений на вариант, а за
      ${days(d.duration)} наберётся ${num(d.actualSample)} — данных в
      ${(d.need / d.actualSample).toFixed(1)} раза меньше, чем нужно. Мощность на ваш порог —
      ${pct(d.powerAtChosen, 0)}: такой тест чаще покажет «разницы нет», чем подтвердит эффект.
      Поднимите срок или долю трафика — оба ползунка ниже.</div>`;
  }

  return `<div class="hint down"><b>↓ Уменьшите до ≈${pct(recommended, 1)}.</b>
    Порог ${pct(state.mde, 1)} выше, чем тест надёжно различает при 80% мощности
    (${pct(recommended, 1)}). Данных с запасом: мощность на ваш порог —
    ${pct(d.powerAtChosen, 0)}. Объявлять планку выше разрешающей способности собственного теста
    бессмысленно — на реальных, но небольших улучшениях вы всё равно закроете изменение.
    Если вас осознанно интересуют только крупные эффекты — оставьте как есть, это ваш бизнес-выбор,
    но тогда не ждите от теста ответов про мелочь.</div>`;
}

/** Подсказка под ползунком доли трафика. */
function shareHint(d) {
  if (state.shareB >= 0.5) {
    return `<div class="hint ok"><b>✓ 50/50 — стандарт.</b> Оба варианта получают максимум данных,
      срок теста минимален, мощность максимальна. Отступать от 50/50 стоит только ради
      безопасности: если вариант B что-то сломает, вы не заметите этого на половине трафика.</div>`;
  }
  return `<div class="hint up"><b>↑ Увеличьте до 50%.</b> На B приходится ${pct(state.shareB, 0)} трафика:
    за ${days(d.duration)} он наберёт ${num(d.actualSample)} наблюдений вместо
    ${num(d.sampleAtHalf)} при 50/50. Данных в ${(d.sampleAtHalf / d.actualSample).toFixed(1)} раза
    меньше, а тест придётся держать примерно во столько же раз дольше.</div>`;
}

/** Подсказка под выбором α. */
function alphaHint(d) {
  const base = sampleSizeProportion(d.baseline, state.mde, POWER_TARGET, 0.05);
  if (state.alpha === 0.05) {
    return `<div class="hint ok"><b>✓ 0.05 — отраслевой стандарт.</b> Примерно каждый 20-й
      «выигранный» тест оказывается ложным. Ниже — про настройку этого параметра под удобство.</div>`;
  }
  if (state.alpha < 0.05) {
    const stricter = sampleSizeProportion(d.baseline, state.mde, POWER_TARGET, 0.01);
    return `<div class="hint up"><b>Строже — честнее, но дороже.</b> При α = ${state.alpha} объём
      выборки растёт примерно в ${(stricter / base).toFixed(2)} раза против α = 0.05, а при 0.01
      ложных побед почти нет. Разумно, если вы открываете результат широкой аудитории
      и цена ошибки высока.</div>`;
  }
  return `<div class="hint down"><b>↓ Это не бесплатно.</b> При α = ${state.alpha} каждый
    ${Math.round(1 / state.alpha)}-й «победитель» — шум. Вы будете выкатывать изменения, которые
    не работают, и называть это победой.</div>`;
}

/**
 * Подсказка под ползунком срока: главный рычаг мощности.
 * Данные копятся линейно, поэтому удвоение срока ровно удвоит объём выборки.
 */
function durationHint(d) {
  const chosen = state.duration;

  // Порог, которого сроком в принципе не достичь: поменять надо MDE
  if (d.daysRecommended > MAX_DAYS) {
    return `<div class="hint up"><b>Срок упёрся в потолок — задача не решается сроком.</b>
      Под MDE ${pct(state.mde, 1)}
      нужно ${num(d.need)} наблюдений на вариант — это ${days(d.daysForSample)}, а максимум
      ${MAX_DAYS}. Одним сроком задачу не закрыть: либо поднимите MDE до ≈${pct(
        d.mdeAchievable,
        1
      )}, либо признайте, что такой тонкий эффект здесь не измерить.</div>`;
  }

  if (chosen < d.daysRecommended) {
    const weeks = Math.round(d.daysRecommended / WEEK);
    return `<div class="hint up"><b>↑ Увеличьте до ${weeks} ${plural(weeks, [
      'недели',
      'недель',
      'недель',
    ])} (${days(d.daysRecommended)}).</b> Под MDE ${pct(state.mde, 1)} нужно ${num(d.need)}
      наблюдений на вариант — это ${days(d.daysForSample)}, а вы держите тест ${days(chosen)}.
      Не хватает ${num(d.need - d.actualSample)} наблюдений. За ${days(d.daysRecommended)}
      типичный эффект ${pct(d.trueMde, 1)} был бы пойман с мощностью ${powerText(
        powerForProportion(d.baseline, d.trueMde, d.bottleneck * d.daysRecommended, state.alpha)
      )}.</div>`;
  }

  if (chosen > d.daysRecommended + WEEK) {
    const extra = chosen - d.daysRecommended;
    return `<div class="hint down"><b>↓ Можно уменьшить до ${days(d.daysRecommended)}.</b>
      Данных уже хватает с запасом: надёжно различимый эффект — ${pct(d.mdeAchievable, 1)},
      мощность на ваш MDE ${pct(d.powerAtChosen, 0)}. Лишние ${days(extra)} — это
      ${num(d.bottleneck * extra)} наблюдений, выброшенных ради уже полученного результата.
      Держите тест дольше только ради устойчивости к выбросам.</div>`;
  }

  // Если типичный эффект меньше различимого, подсказка зелёная по вашему MDE,
  // но произносить оба числа подряд («срок достаточен… и вот 4.45%») сбивает с толку
  const onTrue = powerOk(d.powerOnTrue);
  const tail = onTrue
    ? ` Типичный эффект ${pct(d.trueMde, 1)} будет пойман с мощностью ${powerText(
        d.powerOnTrue
      )}.`
    : '';

  return `<div class="hint ok"><b>✓ По вашему MDE срок достаточен.</b> ${days(chosen)} — кратно полной
      неделе, и данных хватает на порог ${pct(state.mde, 1)} (нужно ${days(d.daysForSample)}).
      Наберётся ${num(d.actualSample)} наблюдений на вариант, надёжно различимый эффект —
      ${pct(d.mdeAchievable, 1)}.${tail} Подробнее о типичном эффекте — в выводе ниже.</div>`;
}

function screenDesign() {
  const scenario = getScenario(state.scenarioId);
  return `
    <div class="card">
      <h2>Шаг 3. Дизайн теста</h2>
      <p class="lead">Сколько данных нужно, чтобы поймать нужный эффект, и сколько это займёт по времени.</p>
      ${scenario.teachingNote ?? ''}

      <div class="note">
        <b>Что означают ползунки.</b> Это три способа получить больше данных, взаимозаменяемые
        по смыслу, но с разной ценой:
        <br>· <b>MDE</b> — насколько мелкое изменение вы хотите заметить. Чем мельче, тем больше
        данных нужно: объём растёт как 1/MDE². Это <b>единственный параметр, который обязателен
        к фиксации до старта</b> — иначе после теста порог удобно подвинут под результат.
        <br>· <b>Срок</b> — сколько дней вы держите тест. Чем дольше, тем больше данных.
        Останавливать досрочно, увидев красивое p-value, — ловушка: это подглядывание.
        <br>· <b>Доля трафика на B</b> — сколько посетителей видит вариант. 50/50 даёт обоим
        вариантам максимум данных; меньше 50% — вариант B набирает их медленнее.
        <br>· <b>α</b> — сколько ложных побед вы готовы терпеть. Не ручка качества: каждый
        сдвиг α меняет вашу долю ошибок.
        <br><br>Подсказки под ползунками подсказывают направление, но решение остаётся за вами.
        Всё настроенное фиксируется в момент нажатия «Запустить».
      </div>

      <div class="params">
        <label>MDE — минимальный эффект, ради которого стоит запускать тест:
          <b class="v-label" data-for="mde"></b>${tip(GLOSSARY.mde.title, GLOSSARY.mde.body)}</label>
        <input type="range" id="mde" min="0.5" max="30" step="0.5">
        <div data-hint="mde"></div>

        <label>Доля трафика на вариант B: <b class="v-label" data-for="share"></b>
          ${tip(GLOSSARY.traffic.title, GLOSSARY.traffic.body)}</label>
        <input type="range" id="share" min="10" max="50" step="5">
        <div data-hint="share"></div>

        <label>Длительность теста: <b class="v-label" data-for="duration"></b>
          <span class="muted">(кратно ${WEEK} дням)</span>
          ${tip(GLOSSARY.duration.title, GLOSSARY.duration.body)}</label>
        <input type="range" id="duration" min="${MIN_DAYS}" max="${MAX_DAYS}" step="${WEEK}">
        <div data-hint="duration"></div>

        <label>Уровень значимости α ${tip(GLOSSARY.alpha.title, GLOSSARY.alpha.body)}</label>
        <select id="alpha">
          <option value="0.05">0.05 — стандарт</option>
          <option value="0.01">0.01 — строже, нужно больше данных</option>
          <option value="0.1">0.10 — нестрого, много ложных побед</option>
        </select>
        <div data-hint="alpha"></div>

        <div class="row">
          <button id="reset">Сбросить параметры</button>
          <span class="muted" style="font-size:13px;align-self:center" id="reset-note"></span>
        </div>
      </div>

      <div id="design-msg"></div>

      <h3>Расчёт</h3>
      <table id="calc-table"><tbody></tbody></table>

      <h3>Что получится на самом деле</h3>
      <p id="reality-lead"></p>
      <table id="reality-table"><tbody></tbody></table>

      <div class="row">
        <button class="primary" id="run"></button>
      </div>
    </div>`;
}

/**
 * Обновляет все зависимые от ползунков части экрана, не трогая сами ползунки.
 *
 * Перерисовывать весь экран на событии input нельзя: элемент ползунка
 * пересоздаётся посреди перетаскивания, браузер теряет захват мыши, и
 * пользователь может сдвинуть его только на одно деление. Поэтому шаблон
 * рендерится один раз, а дальше меняются только текстовые узлы.
 */
function updateDesign() {
  const d = design();
  const mdePercent = (state.mde * 100).toFixed(1);
  const sharePercent = (state.shareB * 100).toFixed(0);

  // Значения самих контролов — иначе после сброса ползунки останутся
  // в старом положении при новом state
  const mdeEl = $('#mde');
  const shareEl = $('#share');
  const durEl = $('#duration');
  const alphaEl = $('#alpha');
  if (mdeEl.value !== mdePercent) mdeEl.value = mdePercent;
  if (shareEl.value !== sharePercent) shareEl.value = sharePercent;
  if (Number(durEl.value) !== state.duration) durEl.value = String(state.duration);
  if (Number(alphaEl.value) !== state.alpha) alphaEl.value = String(state.alpha);

  const labels = {
    mde: `${mdePercent}%`,
    share: `${sharePercent}% (A получит ${100 - Number(sharePercent)}%)`,
    duration: days(state.duration),
  };
  app.querySelectorAll('.v-label').forEach((el) => {
    el.textContent = labels[el.dataset.for];
  });

  app.querySelector('[data-hint="mde"]').innerHTML = mdeHint(d);
  app.querySelector('[data-hint="share"]').innerHTML = shareHint(d);
  app.querySelector('[data-hint="duration"]').innerHTML = durationHint(d);
  app.querySelector('[data-hint="alpha"]').innerHTML = alphaHint(d);

  $('#design-msg').innerHTML = designWarnings();
  const backMetricDesign = $('#back-metric-design');
  if (backMetricDesign) backMetricDesign.onclick = () => backToMetric();
  $('#calc-table tbody').innerHTML = calcRows(d, mdePercent);
  $('#reality-lead').innerHTML = `Объём данных задаёт срок, а не MDE: за ${days(d.duration)} на
    вариант наберётся ${num(d.actualSample)} наблюдений. Вот что из этого следует.`;
  $('#reality-table tbody').innerHTML = realityRows(d, mdePercent);

  const isDefault = isDesignDefault();
  $('#reset').disabled = isDefault;
  $('#reset-note').innerHTML = isDefault
    ? 'параметры уже дефолтные'
    : `вернёт MDE ${pct(DEFAULT_MDE, 0)}, трафик ${pct(DEFAULT_SHARE, 0)}, срок ${DEFAULT_DAYS} дн. и α ${DEFAULT_ALPHA}`;

  $('#run').textContent = `Запустить тест на ${days(state.duration)} →`;

  // Подсказки перерисовываются вместе с экраном, обработчики — заново
  closeTips();
  wireTips();
}

function isDesignDefault() {
  return (
    state.mde === DEFAULT_MDE &&
    state.shareB === DEFAULT_SHARE &&
    state.alpha === DEFAULT_ALPHA &&
    state.duration === DEFAULT_DAYS
  );
}

/** Строки таблицы «Расчёт». */
function calcRows(d, mdePercent) {
  return `
    <tr><td>Базовая конверсия</td><td class="num">${pct(d.baseline)}</td></tr>
    <tr><td>Конверсия B при заявленном MDE ${mdePercent}%</td>
    <td class="num">${pct(d.baseline * (1 + state.mde))}</td></tr>
    <tr><td>Нужный объём на вариант под этот MDE</td><td class="num">${num(d.need)}</td></tr>
    <tr><td>Трафик в вариант B в день</td><td class="num">${num(d.perVariant.B)}</td></tr>
    <tr><td>Срок по объёму данных</td>
    <td class="num">≈ ${days(d.daysForSample)}</td></tr>
    <tr><td>Срок, кратный неделе</td>
    <td class="num">${days(d.daysRecommended)}</td></tr>
    <tr class="hl"><td>Ваш срок</td><td class="num">${days(d.duration)}</td></tr>`;
}

/** Строки таблицы «Что получится на самом деле». */
function realityRows(d, mdePercent) {
  return `
    <tr><td>Данных на вариант за ${days(d.duration)}</td>
    <td class="num">${num(d.actualSample)}</td></tr>
    <tr><td>Нужно под ваш MDE ${mdePercent}%</td>
    <td class="num ${d.actualSample >= d.need ? 'pos' : 'neg'}">${num(d.need)}</td></tr>
    <tr class="hl"><td>Мощность на вашем MDE${tip(GLOSSARY.power.title, GLOSSARY.power.body)}</td>
    <td class="num ${powerOk(d.powerAtChosen) ? 'pos' : 'neg'}">${powerText(d.powerAtChosen)}</td></tr>
    <tr><td>Типичный эффект в этой задаче</td>
    <td class="num">${pct(d.trueMde, 1)}</td></tr>
    <tr><td>Мощность на типичном эффекте</td>
    <td class="num ${powerOk(d.powerOnTrue) ? 'pos' : 'neg'}">${powerText(d.powerOnTrue)}</td></tr>
    <tr><td>Эффект, который тест надёжно отличит от нуля</td>
    <td class="num">${pct(d.mdeAchievable, 2)}</td></tr>`;
}

function designWarnings() {
  const d = design();
  const out = [];
  const trueMde = d.trueMde;

  // Предупреждение о выборе метрики ставим первым: остальные замечания
  // относятся к числам, а это — к постановке вопроса. Проверяем только
  // структурное противоречие (основная метрика объявлена гвардрейлом),
  // оно видно из данных сценария и не подсказывает, какая метрика «правильная».
  const structural = metricProblemStructural(getScenario(state.scenarioId));
  if (structural) out.push(structural);

  if (state.mde < trueMde / 3) {
    const ratio = (trueMde / state.mde) ** 2;
    out.push(
      `<div class="note warn"><b>MDE ${pct(state.mde, 1)} — мельче, чем нужно.</b> Типичный эффект
      здесь около ${pct(trueMde, 1)}, то есть вы гонитесь за изменением, которого не бывает.
      Формула чувствительна к квадрату MDE: уменьшение порога вдвое стоит примерно в
      ${ratio.toFixed(0)} раз больше трафика. Дешевле объявить MDE ${pct(trueMde, 1)}.</div>`
    );
  }

  // Достижимость заявленного MDE при выбранном сроке и трафике
  if (d.actualSample < d.need) {
    out.push(
      `<div class="note bad"><b>Заявленный MDE ${pct(state.mde, 1)} недостижим при выбранном
      сроке.</b> Под него нужно ${num(d.need)} наблюдений на вариант, а за ${days(d.duration)}
      наберётся ${num(d.actualSample)} — данных в ${(d.need / d.actualSample).toFixed(1)} раза
      меньше. Мощность на ваш порог — ${powerText(d.powerAtChosen)}, и такой тест не имеет права
      сказать «изменений нет».${
        d.daysRecommended > MAX_DAYS
          ? `<br>Даже максимума в ${MAX_DAYS} дней не хватит: нужно ${days(
              d.daysRecommended
            )}. Повышайте MDE до ≈${pct(d.mdeAchievable, 1)} или увеличивайте трафик.`
          : `<br>При сроке ${days(d.daysRecommended)} объёма хватило бы — это
             ${num(d.bottleneck * d.daysRecommended)} наблюдений.`
      }</div>`
    );
  }

  if (state.mde > trueMde * 2) {
    // Эффект либо поймается, либо нет: если мощность на него низкая, планку
    // MDE это не спасёт — и обещать «p-value будет крошечным» было бы враньём
    const catchable = powerOk(d.powerOnTrue);
    out.push(
      `<div class="note warn"><b>MDE ${pct(state.mde, 1)} — выше типичного эффекта
      (около ${pct(trueMde, 1)}).</b> Формула тут ни при чём: под ваш заявленный порог данных хватает
      с запасом (мощность ${pct(d.powerAtChosen, 0)}). Проблема в решении.
      ${
        catchable
          ? `Если реальный эффект окажется ${pct(trueMde, 1)}, p-value будет крошечным —
             изменение статистически значимо, но не проходит вашу же планку в
             ${pct(state.mde, 1)}, и его сворачивают.`
          : `Но этот тест типичный эффект в ${pct(trueMde, 1)} вообще не поймает — мощность
             всего ${powerText(d.powerOnTrue)}. Вы увидите «разницы нет» и сделаете вывод, что
             изменение не работает, хотя вопрос просто не адресован этим объёмом данных.`
      }
      <br><br>Заявленный MDE — это обещание, зафиксированное <b>до</b> старта. Двигать его после
      того, как данные посмотрены, — самая дорогая ошибка в A/B-тестировании.</div>`
    );
  }

  if (!powerOk(d.powerOnTrue)) {
    const caught = Math.round(d.powerOnTrue * 100);
    const missPct = Math.round((1 - d.powerOnTrue) * 100);
    const cases = plural(caught, ['случае', 'случаях', 'случаях']);
    const reachable = d.daysForTruePower <= MAX_DAYS;
    out.push(
      `<div class="note bad"><b>Данных не хватит для типичного эффекта.</b> За ${days(
        d.duration
      )} на вариант наберётся ${num(d.actualSample)} наблюдений. Эффект ${pct(
        trueMde,
        1
      )} этот тест поймает примерно в ${caught} ${cases} из 100 — в остальных ${missPct} вы
      увидите «разницы нет» и решите, что изменение не работает.
      ${
        reachable
          ? `<br><br><b>Что делать:</b> продлить тест до ${days(d.daysForTruePower)} — объём
             данных вырастет до ${num(d.bottleneck * d.daysForTruePower)} и мощность дойдёт
             до ${pct(POWER_TARGET, 0)}. Либо примите, что на этом трафике такой эффект
             измеряется ненадёжно, и это тоже результат.`
          : `<br><br><b>Потолок ползунка.</b> Даже на максимальных ${MAX_DAYS} дней мощность
             составит ${powerText(d.powerAtMax)}, а для целевых ${pct(POWER_TARGET, 0)} нужно
             примерно ${num(d.sampleForTrue)} наблюдений на вариант — при вашем трафике
             ${num(d.perVariant.B)} в день это ${humanDays(
               Math.round(d.sampleForTrue / d.perVariant.B)
             )} непрерывного теста. Эффект ${pct(trueMde, 1)} на таком объёме измерить
             нельзя — нужен качественно другой трафик, а не «ещё чуть-чуть подольше».`
      }
      <br><br><b>Поднять MDE здесь не поможет.</b> Мощность зависит от объёма данных и размера
      эффекта, а не от объявленного порога: чем крупнее MDE, тем меньше данных нужно под
      требование, но способность теста увидеть настоящий эффект от этого не меняется.</div>`
    );
  }

  if (state.alpha > 0.05) {
    out.push(
      `<div class="note bad">α = ${state.alpha}: примерно каждый ${(1 / state.alpha).toFixed(
        0
      )}-й «выигранный» тест окажется ложным. Уровень значимости — не ручка настроения:
      он определяет вашу долю ложных побед.</div>`
    );
  }

  if (out.length === 0) {
    out.push(
      `<div class="note good"><b>Дизайн рабочий.</b> За ${days(d.duration)} наберётся ${num(
        d.actualSample
      )} наблюдений на вариант против необходимых ${num(d.need)}. Надёжно различимый эффект —
      ${pct(d.mdeAchievable, 1)}, типичный эффект будет пойман с мощностью ${pct(
        d.powerOnTrue,
        1
      )}.</div>`
    );
  }
  return out.join('');
}

function wireDesign() {
  // Ползунки обновляют только зависимые блоки, себя не пересоздавая:
  // перерисовка на input посреди перетаскивания рвёт захват мыши
  $('#mde').oninput = (e) => {
    state.mde = Number(e.target.value) / 100;
    updateDesign();
  };
  $('#share').oninput = (e) => {
    state.shareB = Number(e.target.value) / 100;
    updateDesign();
  };
  $('#duration').oninput = (e) => {
    state.duration = Number(e.target.value);
    updateDesign();
  };
  $('#alpha').onchange = (e) => {
    state.alpha = Number(e.target.value);
    updateDesign();
  };
  $('#reset').onclick = () => {
    state.mde = DEFAULT_MDE;
    state.shareB = DEFAULT_SHARE;
    state.alpha = DEFAULT_ALPHA;
    state.duration = DEFAULT_DAYS;
    updateDesign();
  };
  $('#run').onclick = () => startExperiment();
  updateDesign();
}

function startExperiment() {
  const scenario = getScenario(state.scenarioId);
  state.sim = runExperiment(scenario, { shareB: state.shareB, days: state.duration });
  state.revealed = 0;
  state.speed = REVEAL_MS;
  state.peekOffered = false;
  state.stoppedAt = null;
  state.earlySnap = null;
  state.srmFlagged = false;
  state.srmStop = false;
  state.step = 3;
  render();
  state.timer = setInterval(tick, state.speed);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function tick() {
  state.revealed += 1;
  const total = state.sim.days.length;
  if (state.revealed >= total) {
    stopTimer();
    state.step = 4;
    render();
    return;
  }
  // Как только вскрывается SRM, останавливаемся: звать «может, выкатим?» после
  // слов «тест недостоверен» — противоречие. Дальше смотреть не на что.
  if (srmDetected() && !state.srmFlagged) {
    state.srmFlagged = true;
    state.peekOffered = false;
    stopTimer();
    renderStep();
    return;
  }
  if (state.revealed >= peekDay(total) && !state.peekOffered && !state.srmFlagged) {
    state.peekOffered = true;
    stopTimer();
    renderStep();
    return;
  }
  renderStep();
}

/** Вскрылся ли SRM на уже накопленных данных. */
function srmDetected() {
  if (!state.sim) return false;
  const scenario = getScenario(state.scenarioId);
  const snap = snapshot(scenario, state.sim.days.slice(0, state.revealed));
  return snap.srm.srm;
}

// ============================================================ шаг 3: наблюдение

function screenObserve() {
  const scenario = getScenario(state.scenarioId);
  const shown = state.sim.days.slice(0, state.revealed);
  const snap = snapshot(scenario, shown);
  const cum = cumulativeByDay(state.sim.days).slice(0, state.revealed);
  const res = primaryResult(scenario, snap);
  const guard = guardrailCheck(scenario, snap);
const total = state.sim.days.length;
  const peekAt = peekDay(total);
  // Доля теста, к которой уже накопились данные — то, на что вы смотрите
  const share = peekAt / total;
  const shareText = `${Math.round(share * 100)}%`;
  const srm = snap.srm.srm;

  const peek = state.peekOffered
    ? `<div class="note bad"><b>Руководитель прибежал с вопросом.</b>
        «Прошло ${peekAt} ${plural(peekAt, ['день', 'дня', 'дней'])} из ${total}, метрики расходятся — может, выкатим?»
        <div class="row">
          <button class="danger" id="stopNow">Остановить тест и объявить победителя</button>
          <button class="primary" id="keepGoing">Продолжить до конца</button>
        </div>
        <p style="margin-bottom:0">Соблазн велик: p-value уже на экране, и он выглядит
        убедительно. Но это решение опирается на ${shareText} будущего результата —
        данные за ${days(peekAt)} из ${total}.${tip(GLOSSARY.peeking.title, GLOSSARY.peeking.body, ' right')}
        Каждая такая проверка в середине теста — дополнительная попытка поймать шум,
        и именно она порождает ложные открытия. Срок и объём выборки были
        зафиксированы до старта: дождаться конца стоит бесплатно, а вот пересмотреть
        план задним числом — нет.</p></div>`
    : '';

  return `
    <div class="card">
      <h2>Шаг 4. Наблюдение</h2>
      <p class="lead">Идёт ${state.revealed} из ${total} дней. Мониторинг показывает всё, что увидел бы аналитик,
      — но он не знает, когда тест закончится.</p>
      <div class="bar"><i style="width:${(state.revealed / total) * 100}%"></i></div>

      <h3>Накопительная конверсия</h3>
      ${chartSvg(cum, scenario)}
      <div class="legend">
        <span><i style="background:var(--a)"></i>Вариант A — ${pct(snap.conv.pa)}</span>
        <span><i style="background:var(--b)"></i>Вариант B — ${pct(snap.conv.pb)}</span>
      </div>

      <h3>Текущие цифры</h3>
      <table>
        <tr><th>Метрика</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th><th class="num">p</th></tr>
        ${metricRow('ctr', snap, state.primary === 'ctr', srm)}
        ${metricRow('conversion', snap, state.primary === 'conversion', srm)}
        ${metricRow('arpu', snap, state.primary === 'arpu', srm)}
        <tr>
          <td>Распределение трафика (SRM)${tip(GLOSSARY.srm.title, GLOSSARY.srm.body, ' right')}</td>
          <td class="num">${pct(1 - snap.shareB, 1)}</td>
          <td class="num">${pct(snap.shareB, 1)}</td>
          <td class="num ${srm ? 'neg' : 'muted'}">χ²=${snap.srm.chi2.toFixed(2)}</td>
          <td class="num ${srm ? 'neg' : 'muted'}">${srm ? 'нарушение' : 'ок'}</td>
        </tr>
      </table>
      ${srm ? '<p class="muted" style="font-size:13px">Ожидалось по настройке: A — ' +
        `${pct(1 - state.shareB, 1)}, B — ${pct(state.shareB, 1)}.</p>` : ''}
        ${
        // Заметку про сломанный гвардрейл показываем только когда результаты вообще можно читать: при SRM
        // все метрики недостоверны, и упоминать о падении конверсии значит предъявлять несуществующий вывод.
        // Блок был продублирован: одна копия печаталась всегда, вторая только без SRM,
        // и на экране оставались два одинаковых сообщения подряд.
        guard.broken && !snap.srm.srm
          ? `<div class="note bad"><b>Гвардрейл сломан.</b> «${escapeHtml(
              METRICS[guard.id].label
            )}» ${fell(guard.id)} на ${signed(guard.res.relLift)} — это больше зафиксированного порога
            ${pct(GUARDRAIL_DROP, 0)}. По заранее согласованному правилу такую выкатку не проводят,
            сколько бы ни выросла основная метрика.${
              tip(GLOSSARY.guardrail.title, GLOSSARY.guardrail.body, ' right')
            }</div>`
          : ''
      }
      ${
        // При SRM все метрики ниже — недостоверны. Говорить про p-value и
        // предлагать «выкатим?» после слов «дальше считать бессмысленно»
        // было бы прямой ошибкой, поэтому при нарушении ловушки и вывода нет
        snap.srm.srm
          ? `<div class="note bad"><b>Sample Ratio Mismatch: тест недостоверен.</b>
        В вариант B попало ${pct(snap.shareB, 1)} трафика вместо запланированных
        ${pct(state.shareB, 1)} — расхождение не случайно (χ² = ${snap.srm.chi2.toFixed(
              2
            )}, p ${formatPExpr(snap.srm.pValue)}).
        <br><br>Обычные причины: баг в бакетере, фильтр по устройству, разные версии SDK,
        потеря событий на одной из сторон.
        <br><br><b>Все метрики выше недействительны.</b> При неверном распределении групп
        сравнивать их нельзя: неизвестно, что именно попало в вариант B. Прекратите тест
        и чините рандомизацию — продолжать бессмысленно, а принимать решение по этим
        цифрам опасно. Воспроизведите проверку до повторного запуска.</div>
        <div class="row">
          <button class="danger" id="stopSrm">Остановить тест из-за SRM</button>
        </div>`
          : `<div class="note ${res.significant ? 'warn' : ''}">По выбранной основной метрике
        (<b>${escapeHtml(METRICS[state.primary].label)}</b>): изменение ${signed(res.relLift)}.
        <b>Вывод:</b> ${verdictText(res)}.</div>
        ${peek}
        <div class="row">
          <button id="fast" ${state.timer ? '' : 'disabled'}>Ускорить ×5</button>
        </div>`
      }
    </div>`;
}

function wireObserve() {
  const fast = $('#fast');
  if (fast) {
    fast.onclick = () => {
      stopTimer();
      state.speed = 60;
      state.timer = setInterval(tick, state.speed);
      renderStep();
    };
  }
  const keep = $('#keepGoing');
  if (keep) {
    keep.onclick = () => {
      stopTimer();
      state.timer = setInterval(tick, REVEAL_MS);
      renderStep();
    };
  }
  // У двух кнопок было id="stopNow": одна — ранняя остановка по воле ученика,
  // вторая — остановка из-за SRM. Одновременно они не рендерятся, но дублировать
  // идентификатор в одном документе нельзя, и любой поиск по id давал бы
  // неоднозначный результат.
  const stopSrm = $('#stopSrm');
  if (stopSrm) {
    stopSrm.onclick = () => {
      stopTimer();
      state.srmStop = true;
      state.step = 4;
      render();
    };
  }
  const stop = $('#stopNow');
  if (stop) {
    stop.onclick = () => {
      stopTimer();
      state.stoppedAt = state.revealed;
      const shown = state.sim.days.slice(0, state.stoppedAt);
      state.earlySnap = snapshot(getScenario(state.scenarioId), shown);
      state.step = 4;
      render();
    };
  }
}

// ============================================================ график

/**
 * Строка таблицы для одной метрики.
 * При SRM значения показаны, но помечены как недействительные: аналитик видит
 * цифры и одновременно видит, что принимать по ним решение нельзя. Молча
 * скрывать колонки значило бы прятать от пользователя сам диагностический признак.
 */
function metricRow(metricId, snap, isPrimary, srm = false) {
  const res = metricResult(metricId, snap);
  const isMean = metricId === 'arpu';
  const fmt = isMean ? money : (v) => pct(v);
  const valA = isMean ? res.meanA : res.pa;
  const valB = isMean ? res.meanB : res.pb;
  const dim = srm ? ' style="opacity:.45"' : '';
  return `<tr${isPrimary ? ' class="hl"' : ''}${dim}>
          <td>${escapeHtml(METRICS[metricId].label)}${isPrimary ? ' — основная' : ''}${
    srm ? ' <span class="tag warn">недействительно</span>' : ''
  }</td>
          <td class="num">${fmt(valA)}</td>
          <td class="num">${fmt(valB)}</td>
          <td class="num ${cls(res.relLift)}">${signed(res.relLift)}</td>
          <td class="num">${srm ? '—' : formatP(res.pValue)}</td>
        </tr>`;
}

function chartSvg(cum, scenario) {
  const W = 880;
  const H = 260;
  const pad = { l: 52, r: 16, t: 14, b: 26 };
  if (!cum.length) return '';
  const rates = cum.flatMap((d) => [d.rateA, d.rateB]);
  const base = scenario.baselineConversion;
  let lo = Math.min(...rates, base) * 0.97;
  let hi = Math.max(...rates, base) * 1.03;
  if (hi - lo < 1e-4) {
    lo -= 0.002;
    hi += 0.002;
  }
  const x = (i) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, cum.length - 1);
  const y = (v) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / (hi - lo);

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = lo + (hi - lo) * f;
      return `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${W - pad.r}" y2="${y(v).toFixed(
        1
      )}" stroke="#2a3441" stroke-width="1"/>
              <text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" fill="#6b7887" font-size="11"
                text-anchor="end">${(v * 100).toFixed(2)}%</text>`;
    })
    .join('');

  const line = (key) =>
    cum.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');

  const baseLine = `<line x1="${pad.l}" y1="${y(base).toFixed(1)}" x2="${W - pad.r}" y2="${y(base).toFixed(
    1
  )}" stroke="#4c9aff" stroke-width="1" stroke-dasharray="4 4" opacity="0.45"/>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Накопительная конверсия по дням">
    ${gridLines}${baseLine}
    <polyline points="${line('rateA')}" fill="none" stroke="var(--a)" stroke-width="2"/>
    <polyline points="${line('rateB')}" fill="none" stroke="var(--b)" stroke-width="2"/>
    ${cum
      .map((d, i) => {
        // Подписываем ось не каждый день, иначе при 56 днях подписи слиплись бы
        const labelStep = Math.max(1, Math.ceil(cum.length / 12));
        if (i % labelStep !== 0 && i !== cum.length - 1) return '';
        return `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="#6b7887" font-size="11"
            text-anchor="middle">${d.day + 1}</text>`;
      })
      .join('')}
  </svg>`;
}

// ============================================================ шаг 4: решение

function screenDecision() {
  const scenario = getScenario(state.scenarioId);
  const shown = state.sim.days.slice(0, state.revealed);
  const snap = snapshot(scenario, shown);
  const res = primaryResult(scenario, snap);
  const guard = guardrailCheck(scenario, snap);
  const early = !state.srmStop && state.stoppedAt !== null && state.stoppedAt < state.sim.days.length;
  const srmStop = state.srmStop;

  const finalSnap = snapshot(scenario, state.sim.days);
  const finalRes = primaryResult(scenario, finalSnap);

  const earlyRes = state.earlySnap ? primaryResult(scenario, state.earlySnap) : res;
  const verdictChanged = earlyRes.significant !== finalRes.significant;
  const earlyBlock = early
    ? `<div class="note bad"><b>Тест остановлен на ${state.stoppedAt}-м дне из ${state.sim.days.length}.</b>
        На тот момент p ${formatPExpr(earlyRes.pValue)} и эффект выглядел как ${signed(earlyRes.relLift)}.
        На полных данных p ${formatPExpr(finalRes.pValue)}, эффект ${signed(finalRes.relLift)}.
        ${
          verdictChanged
            ? earlyRes.significant
              ? 'Значимость на финише пропала — вы объявили победителя там, где его нет.'
              : 'Значимости на финише не появилось — вы едва не выкатили шум.'
            : 'Вывод в целом не изменился, но он был принят на 1/3 данных: именно так и рождаются ложные открытия в реальных экспериментах.'
        }</div>`
    : '';

  const srmStopBlock = srmStop
    ? `<div class="note bad"><b>Тест остановлен из-за нарушения рандомизации, а не из-за результата.</b>
        На ${state.revealed}-м дне из ${state.sim.days.length} доли трафика разошлись:
        в B попало ${pct(snap.shareB, 1)} вместо ${pct(state.shareB, 1)}
        (χ² = ${snap.srm.chi2.toFixed(2)}, p ${formatPExpr(snap.srm.pValue)}).
        <br><br>Сравнивать метрики в разошедшихся группах нельзя: неизвестно, что именно
        попало в вариант B. Правильное действие одно — остановиться и чинить бакетер.
        Никакое решение о выкатке по этим данным принять нельзя, даже если цифры выглядят
        убедительно.</div>`
    : '';

  return `
    <div class="card">
      <h2>Шаг 5. Решение</h2>
      <p class="lead">${srmStop
        ? 'Тест прерван на ' + state.revealed + '-м дне.'
        : `Все ${state.revealed} дней собраны. Что делаем с вариантом B?`}</p>
      ${srmStopBlock}
      ${earlyBlock}
      ${resultTable(scenario, snap)}
      <h3>Итог статистики</h3>
      <div class="grid2">
        <div>
          <div class="kpi"><span>Основная метрика</span><span class="v">${escapeHtml(
            METRICS[state.primary].label
          )}</span></div>
          <div class="kpi"><span>Изменение</span><span class="v ${cls(res.relLift)}">${signed(res.relLift)}</span></div>
          <div class="kpi"><span>95% ДИ на Δ${tip(GLOSSARY.ci.title, GLOSSARY.ci.body, ' right')}</span>
          <span class="v">${pct(res.ci[0])} … ${pct(res.ci[1])}</span></div>
          <div class="kpi"><span>p-value</span><span class="v">${formatP(res.pValue)}</span></div>
          <div class="kpi"><span>Вывод при α = ${state.alpha}</span><span class="v ${
            res.significant ? 'pos' : 'muted'
          }">${res.significant ? 'значимо' : 'не значимо'}</span></div>
        </div>
        <div>
          <div class="kpi"><span>Выборка A / B</span><span class="v">${num(snap.t.visitors.A)} / ${num(
          snap.t.visitors.B
        )}</span></div>
          <div class="kpi"><span>Гвардрейл: ${escapeHtml(METRICS[guard.id].label)}${tip(
            GLOSSARY.guardrail.title,
            GLOSSARY.guardrail.body,
            ' right'
          )}</span>
            <span class="v ${guard.broken ? 'neg' : cls(guard.res.relLift)}">${signed(guard.res.relLift)}</span></div>
          <div class="kpi"><span>Гвардрейл p-value</span><span class="v">${formatP(guard.res.pValue)}</span></div>
          <div class="kpi"><span>Порог падения гвардрейла</span>
            <span class="v">−${pct(GUARDRAIL_DROP, 0)} → ${
          guard.broken ? '<span class="neg">нарушен</span>' : 'ок'
        }</span></div>
          <div class="kpi"><span>Проверка трафика (SRM)</span><span class="v ${
            snap.srm.srm ? 'neg' : 'pos'
          }">${snap.srm.srm ? 'нарушение' : 'в порядке'}</span></div>
          <div class="kpi"><span>Заранее нужен объём</span><span class="v">${num(
            design().need
          )} на вариант</span></div>
          <div class="kpi"><span>Фактически накоплено</span><span class="v">${num(
            Math.min(snap.t.visitors.A, snap.t.visitors.B)
          )}</span></div>
        </div>
      </div>
      ${
        guard.broken
          ? `<div class="note bad">По заранее зафиксированному правилу гвардрейл важнее основной метрики:
             падение «${escapeHtml(METRICS[guard.id].label)}» на ${signed(
            guard.res.relLift
          )} блокирует выкатку.</div>`
          : ''
      }
      ${hypothesisPanel(scenario, snap)}
      ${metricProblemHtml(scenario)}
      <div class="row">
        <button class="primary" data-dec="ship">Выкатить вариант B</button>
        <button data-dec="hold">Не выкатывать, вернуть к A</button>
        <button data-dec="more">Продолжить ещё на ${days(WEEK)}${
    state.extendedDays ? ` <span class="muted">(уже +${state.extendedDays})</span>` : ''
  }</button>
      </div>
    </div>`;
}

function resultTable(scenario, snap) {
  return `
    <table>
      <tr><th>Вариант</th><th class="num">Трафик</th><th class="num">Покупки</th>
      <th class="num">Конверсия</th><th class="num">Выручка/сессия</th></tr>
      <tr>
        <td>A (контроль)</td>
        <td class="num">${num(snap.t.visitors.A)}</td>
        <td class="num">${num(snap.t.conv.A)}</td>
        <td class="num">${pct(snap.conv.pa)}</td>
        <td class="num">${money(snap.arpu.meanA)}</td>
      </tr>
      <tr class="hl">
        <td>B (вариант)</td>
        <td class="num">${num(snap.t.visitors.B)}</td>
        <td class="num">${num(snap.t.conv.B)}</td>
        <td class="num">${pct(snap.conv.pb)}</td>
        <td class="num">${money(snap.arpu.meanB)}</td>
      </tr>
      <tr>
        <td>Δ</td><td class="num"></td><td class="num"></td>
        <td class="num ${cls(snap.conv.relLift)}">${signed(snap.conv.relLift)}</td>
        <td class="num ${cls(snap.arpu.relLift)}">${signed(snap.arpu.relLift)}</td>
      </tr>
    </table>`;
}

function wireDecision() {
  document.querySelectorAll('[data-dec]').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.dec === 'more') {
        extendTest(WEEK);
        return;
      }
      state.decision = btn.dataset.dec;
      state.step = 5;
      render();
    };
  });
  const back = $('#back-metric');
  if (back) back.onclick = () => backToMetric();
}

/**
 * Продлевает тест на extraDays дней.
 *
 * Генерировать дни заново, а не дописывать к существующим: симуляция сразу
 * считает весь срок, и к концу теста в state.sim.days уже нет свободных дней.
 * При этом первые N дней не меняются — каждому дню соответствует свой поток
 * случайных чисел (seed + day*7919), не зависящий от общей длительности.
 */
function extendTest(extraDays) {
  const scenario = getScenario(state.scenarioId);
  const total = state.sim.days.length + extraDays;

  // Запоминаем, что было видно до продления: если вывод затем поменяется,
  // это подглядывание, а не добросовестное «дождаться»
  if (!state.beforeExtend) {
    const snap = snapshot(scenario, state.sim.days);
    state.beforeExtend = {
      days: state.sim.days.length,
      significant: primaryResult(scenario, snap).significant,
      relLift: primaryResult(scenario, snap).relLift,
    };
  }

  const extended = runExperiment(scenario, { shareB: state.shareB, days: total });
  state.sim.days = extended.days;
  state.sim.total = extended.total;
  state.sim.config.days = total;
  state.extendedDays += extraDays;
  // Показываем сразу все собранные данные — пользователь видит, к чему привёл
  // отложенное решение
  state.revealed = total;
  renderStep();
}

function wireDebrief() {
  const restart = $('#restart');
  if (restart) restart.onclick = () => startScenario(state.scenarioId);
  const other = $('#other');
  if (other) other.onclick = () => showHome();
}

// ============================================================ шаг 5: разбор

function screenDebrief() {
  const scenario = getScenario(state.scenarioId);
  const finalSnap = snapshot(scenario, state.sim.days);
  const finalRes = primaryResult(scenario, finalSnap);
  const guard = guardrailCheck(scenario, finalSnap);
  const expected = correctAction(scenario, finalSnap);
  const issues = collectIssues(scenario, finalSnap, expected);
  const correct = state.decision === expected.action;

  const verdict = correct
    ? '<div class="note good"><b>Решение верное.</b></div>'
    : `<div class="note bad"><b>Решение неверное.</b> По данным эксперимента следовало:
      «${expected.text}».</div>`;

  const score = issues.filter((i) => i.type === 'err').length;
  saveProgress(scenario, correct, score);

  return `
    <div class="card">
      <h2>Шаг 6. Разбор</h2>
      <p class="lead">Сценарий «${escapeHtml(scenario.title)}» завершён. Ошибок в процессе:
      <b>${score}</b>.</p>
      ${verdict}
      <h3>Что было в данных на самом деле</h3>
      ${
        finalSnap.srm.srm
          ? `<div class="note bad"><b>Строки ниже показывают, что именно сломалось, а не
             результат эксперимента.</b> Рандомизация нарушена, поэтому ни одна метрика
             в этой таблице не может использоваться для решения. Читайте их как
             описание поломки.</div>`
          : ''
      }
      <table>
        <tr><td>CTR: A → B</td>
        <td class="num">${pct(finalSnap.ctr.pa)} → ${pct(finalSnap.ctr.pb)}
        <span class="${cls(finalSnap.ctr.relLift)}">(${signed(finalSnap.ctr.relLift)})</span></td></tr>
        <tr><td>Итоговая конверсия A → B</td>
        <td class="num">${pct(finalSnap.conv.pa)} → ${pct(finalSnap.conv.pb)}</td></tr>
        <tr><td>Относительное изменение конверсии</td>
        <td class="num ${cls(finalSnap.conv.relLift)}">${signed(finalSnap.conv.relLift)}</td></tr>
        <tr><td>p-value по конверсии на полных данных</td>
        <td class="num">${formatP(finalSnap.conv.pValue)}</td></tr>
        <tr><td>Гвардрейл «${escapeHtml(METRICS[guard.id].label)}»</td>
        <td class="num ${cls(guard.res.relLift)}">${signed(guard.res.relLift)}
        (p ${formatPExpr(guard.res.pValue)})${guard.broken ? ' — нарушен' : ''}</td></tr>
        <tr><td>Мощность теста на типичном эффекте ${pct(
          Math.abs(realizedConversionLift(scenario, actualDuration())),
          1
        )}</td>
        <td class="num ${powerOk(design().powerOnTrue) ? 'pos' : 'neg'}">${powerText(design().powerOnTrue)}</td></tr>
        <tr><td>Проверка распределения трафика</td>
        <td class="num ${finalSnap.srm.srm ? 'neg' : ''}">${
          finalSnap.srm.srm
            ? `χ² = ${finalSnap.srm.chi2.toFixed(2)}, p ${formatPExpr(finalSnap.srm.pValue)} — SRM`
            : `χ² = ${finalSnap.srm.chi2.toFixed(2)}, p ${formatPExpr(finalSnap.srm.pValue)} — ок`
        }</td></tr>
      </table>
      ${
        // Подсказка имеет смысл, только когда прокси-метрика выросла заметно
        // сильнее бизнес-метрики: иначе обе метрики просто неудачны
        finalSnap.ctr.relLift > 0 && finalSnap.ctr.relLift > Math.abs(finalSnap.conv.relLift) * 2
          ? `<div class="note warn"><b>Прокси-метрика разошлась с бизнес-метрикой.</b>
             CTR вырос на ${signed(finalSnap.ctr.relLift)} (p ${formatPExpr(finalSnap.ctr.pValue)}),
             а конверсия — лишь на ${signed(finalSnap.conv.relLift)}
             (p ${formatPExpr(finalSnap.conv.pValue)}). Люди стали кликать чаще, но покупать — нет.
             Если бы основной метрикой был CTR, вы выкатили бы изменение, которое ничего не даёт бизнесу.</div>`
          : ''
      }
      <h3>Ваш чек-лист</h3>
      <div class="issues">${issues.map(issueHtml).join('')}</div>
      ${scenario.teachingNote ? brokenByDesign(scenario) : ''}
      ${scenario.teachingNote ? debriefNote(scenario, finalSnap) : ''}
      <div class="note">
        <b>Что стоит запомнить.</b>
        «Изменений нет» и «мы не смогли проверить» — разные выводы.
        ${tip(GLOSSARY.ci.title, GLOSSARY.ci.body)}
        ${tip(GLOSSARY.peeking.title, GLOSSARY.peeking.body)}
        ${tip(GLOSSARY.proxy.title, GLOSSARY.proxy.body)}
      </div>
      <div class="row">
        <button class="primary" id="restart">Пройти заново</button>
        <button id="other">Другой сценарий</button>
      </div>
    </div>`;
}

/**
 * Почему в этом кейсе ломается всегда — разбор замысла сценария.
 *
 * Кейс про «тест, который выиграл на первой неделе». Задача в нём
 * нечестная по построению: правильной комбинации параметров не существует,
 * и ученик не может прийти к «тест прошёл» никаким выбором MDE, срока
 * или доли трафика. Поэтому список поломок важен: он превращает
 * ощущение «я что-то сделал не так» в понимание, что так устроены данные.
 *
 * Все числа берутся из сценария и расчёта, а не выдуманы: если сценарий
 * переделают, текст пересчитается сам и не станет врать.
 */
function brokenByDesign(scenario) {
  const d = design();
  const t = scenario.truth;
  const shortBy = num(1 / Math.max(d.powerOnTrue, 0.001));

  const defects = [];

  if (scenario.traps.srm) {
    defects.push([
      'Рандомизация сломана',
      `в вариант B попадает ${pct(scenario.traps.srmShareB, 0)} трафика вместо 50%. Это не «вариант
        B оказался удачнее», а «мы сравниваем две разные группы людей». Все метрики,
        все p-value и все доверительные интервалы в таком тесте недостоверны, поэтому
        правильный вывод — не «выкатывать», а «остановить и чинить рандомизацию».
        Проверка SRM стоит первм пунктом в мониторинге именно потому, что обнаруживает
        это в первый же день.`,
    ]);
  }

  defects.push([
    'Эффект физически не измерим',
    `реальное изменение около ${pct(d.trueMde, 1)}, а данных у маркетплейса
      ${num(scenario.trafficPerDay)} в день. Мощность — ${powerText(d.powerOnTrue)}: типичный
      эффект этот тест поймает примерно в ${Math.round(
      d.powerOnTrue * 100
    )} случаях из 100. Поднять мощность до ${pct(POWER_TARGET, 0)} можно только
      объёмом — а он требует ${num(d.sampleForTrue)} наблюдений на вариант, это
      ${humanDays(Math.round(d.sampleForTrue / d.bottleneck))}. Данных примерно в
      <b>${shortBy} раз</b> меньше нужного, и никакой MDE, срок или доля трафика
      в пределах ползунка эту разницу не закроют.`,
  ]);

  defects.push([
    'Эффект направлен против бизнеса',
    `кликабельность растёт на ${signed(t.ctrLiftRel)} — ровно то, чего хотел заказчик, —
      но вероятность купить после клика падает на ${signed(t.condConversionLiftRel)}.
      Баннер приводит клики, которые не покупают. Именно поэтому CTR нельзя
      ставить основной метрикой: по ней изменение «побеждает», по деньгам —
      проигрывает, а гвардрейл по конверсии нарушается.`,
  ]);

  defects.push([
    'Задача сформулирована прокси-метрикой',
    `в брифе стоит «кликабельность вырастет», и тест, построенный под эту фразу,
      честно подтверждает: кликабельность выросла. Ровно это и есть опасность
      продуктовых метрик — они отвечают на заданный вопрос, а не на вопрос
      «стало ли лучше».`,
  ]);

  return `<div class="note">
      <b>Почему в этом кейсе всё ломается всегда.</b> Кейс собран так, что
      правильной комбинации параметров не существует. Это не ошибка вашего решения —
      это устройство задачи, и вот четыре поломки, каждая из которых
      самостоятельно делает успешный тест невозможным.
      <ul style="margin:8px 0 0;padding-left:20px">
        ${defects
          .map(([h, b]) => `<li style="margin-bottom:8px"><b>${h}.</b> ${b}</li>`)
          .join('')}
      </ul>
      <br>Что из этого следует практически: сначала воспроизводится проверка
      рандомизации на кухонном стенде, и только потом запускается тест. Если после
      этого мощность всё ещё ${powerText(d.powerOnTrue)}, вопрос честно закрывается
      как <b>«изменение не измеримо на нашем трафике»</b> — и это нормальный
      результат, который экономит месяцы работы.</div>`;
}

/**
 * Финальный аккорд для сценариев с заведомо неизмеримым эффектом.
 *
 * Формулировка зависит от того, что тест показал на самом деле: в кейсе с
 * поломкой рандомизации p-value недействителен, и говорить «вы получили
 * p-value около нуля» было бы враньём.
 */
function debriefNote(scenario, snap) {
  const d = design();
  const res = primaryResult(scenario, snap);
  const shortBy = num(1 / Math.max(d.powerOnTrue, 0.001));
  const needed = `${num(d.sampleForTrue)} наблюдений на вариант — ${humanDays(
    Math.round(d.sampleForTrue / d.bottleneck)
  )}`;

  let verdict;
  if (snap.srm.srm) {
    verdict = `Данные этого теста недостоверны: доли трафика разошлись, поэтому метрики
      сравнивать нельзя. О p-value здесь говорить нельзя — он не имеет смысла.`;
  } else if (res.significant) {
    verdict = `Формально p-value значимо, и это само по себе выглядит как победа. Но даже
      <b>правильный</b> вывод «выкатывать» здесь поспешен: объём данных не позволяет
      отличить настоящий эффект от случайности, значимость получена на грани шума.`;
  } else {
    verdict = `p-value около нуля — и это тоже не ответ. Отсутствие значимости при слабой
      мощности означает «не хватило данных», а не «эффекта нет».`;
  }

  return `<div class="note"><b>Про «разницы нет» в этом сценарии.</b>
    ${verdict}
    <br><br>Главное здесь — мощность. На типичный эффект ${pct(d.trueMde, 1)} она составляет
    ${powerText(d.powerOnTrue)}, а для целевых ${pct(POWER_TARGET, 0)} нужно ${needed}.
    Данных примерно в <b>${shortBy} раз</b> меньше нужного.
    <br><br>По-настоящему честный вывод звучит не «изменение не работает», а
    <b>«эксперимент не дал ответа»</b>. Если эффект около ${pct(
    d.trueMde,
    1
  )} существует, ваш тест его просто не увидел. Увеличивать трафик в
    ${shortBy} раз — не разумная цена вопроса; на таких объёмах вывод делают
    другим способом: длиннее тест, точнее метрика или принципиально признать,
    что задача неразрешима тестом.</div>`;
}

/** Какое решение на самом деле следовало принять. */
function correctAction(scenario, snap) {
  if (snap.srm.srm) {
    return { action: 'hold', text: 'остановить тест и чинить рандомизацию (SRM)' };
  }
  const res = primaryResult(scenario, snap);
  const guard = guardrailCheck(scenario, snap);
  if (guard.broken) {
    return {
      action: 'hold',
      text: `не выкатывать: основная метрика «${METRICS[state.primary].label}» выросла, `
        + `но гвардрейл «${METRICS[guard.id].label}» ${fell(guard.id)} на ${signed(guard.res.relLift)} — `
        + `это больше зафиксированного порога в ${pct(GUARDRAIL_DROP, 0)}`,
    };
  }
  if (!res.significant) {
    return { action: 'hold', text: 'не выкатывать: данных недостаточно для вывода' };
  }
  return {
    action: res.relLift > 0 ? 'ship' : 'hold',
    text: res.relLift > 0 ? 'выкатить вариант B' : 'не выкатывать: эффект отрицательный',
  };
}

function issueHtml(i) {
  return `<div class="issue ${i.type}">
    <div class="h">${escapeHtml(i.h)}</div>
    <div class="b">${i.b}</div>
  </div>`;
}

function collectIssues(scenario, snap, expected) {
  const out = [];
  // Знак эффекта не важен для оценки MDE — важен его размер
  const trueMde = Math.abs(realizedConversionLift(scenario, actualDuration()));

  // --- гипотеза
  const hypProblems = checkHypothesis(state.hypothesis);
  if (hypProblems.length === 0) {
    out.push({
      type: 'ok',
      h: 'Гипотеза сформулирована корректно',
      b: 'Есть условная конструкция, метрика и ожидаемое направление — по ней можно заранее договориться о критерии успеха.',
    });
  } else {
    out.push({
      type: 'miss',
      h: 'Гипотеза была неполной',
      b: `Не хватало: ${hypProblems.join('; ')}. Критерий успеха нужно зафиксировать <b>до</b> запуска, иначе результат будет подогнан под желаемое.`,
    });
  }

  // --- метрика
  const metricProblemHere = metricProblem(scenario);
  if (!metricProblemHere) {
    out.push({
      type: 'ok',
      h: 'Основная метрика выбрана верно',
      b: `«${METRICS[state.primary].label}» отражает ценность изменения, а гвардрейл «${scenario.guardrails
        .map((g) => METRICS[g].label)
        .join('», «')}» не даст выкатить вредный вариант.`,
    });
  } else {
    out.push({
      type: 'err',
      h: metricProblemHere.title,
      b:
        scenario.guardrails.includes(state.primary)
          ? `${metricProblemHere.body} Правило выката строилось как «главная метрика растёт,
             гвардрейл не падает» — и с двумя одинаковыми метриками оно теряет смысл.`
          : `${metricProblemHere.body} В этом тесте прокси изменилась на ${signed(
              snap.ctr.relLift
            )}, а бизнес-метрика — лишь на ${signed(snap.conv.relLift)}.`,
    });
  }

  // --- дизайн
  const d = design();
  if (state.mde > trueMde * 2) {
    out.push({
      type: 'err',
      h: `MDE завышен в ${(state.mde / trueMde).toFixed(1)} раза`,
      b: `Вы объявили порог ${pct(state.mde, 1)}, а типичный эффект здесь около ${pct(trueMde, 1)}.
        Под ваш порог тест закончен формально (мощность ${powerText(d.powerAtChosen)}), но настоящий
        эффект такой величины он заметил бы лишь с вероятностью ${powerText(d.powerOnTrue)}.
        Такой тест не имеет права делать вывод «эффекта нет» — он просто его не видел.`,
    });
  } else if (state.mde < trueMde / 3) {
    out.push({
      type: 'miss',
      h: 'MDE избыточно мелкий',
      b: 'Тест стоит в несколько раз дороже, а размер выборки растёт как 1/MDE². Практический ориентир: MDE на границе, где изменение ещё ценно для бизнеса.',
    });
  } else {
    out.push({
      type: 'ok',
      h: 'MDE выбран осмысленно',
      b: `${pct(state.mde, 1)} — разумная граница значимости для этой задачи: типичный эффект
        (${pct(trueMde, 1)}) этот тест поймал с мощностью ${pct(d.powerOnTrue, 0)}.`,
    });
  }

  if (state.alpha !== 0.05) {
    out.push({
      type: state.alpha > 0.05 ? 'err' : 'miss',
      h: `Уровень значимости ${state.alpha} — нестандартный`,
      b:
        state.alpha > 0.05
          ? 'Расслабление α напрямую покупает ложные победы. При α = 0.1 каждый десятый «победитель» — шум.'
          : 'Строгий α — это честно, но оборачивается ростом срока и объёма выборки. Убедитесь, что это осознанный размен.',
    });
  }

  // --- продление теста
  if (state.extendedDays > 0) {
    const before = state.beforeExtend;
    const flipped = before && before.significant !== primaryResult(scenario, snap).significant;
    out.push(
      flipped
        ? {
            type: 'err',
            h: `Тест продлён на ${days(state.extendedDays)} уже после того, как результат увидели`,
            b: `На ${days(before.days)} p был ${before.significant ? 'значимым' : 'незначимым'}
            (${signed(before.relLift)}), а после продления вывод изменился на противоположный.
            Продление законно, только если о нём договорились <b>до</b> старта. Решение «досижу
            ещё неделю» после того, как цифра уже на экране, — это подглядывание: вы ищете
            не данные, а подтверждение нужного вывода.`,
          }
        : {
            type: 'miss',
            h: `Тест продлён на ${days(state.extendedDays)} постфактум`,
            b: `Здесь повезло: вывод не изменился. Но полагаться на это нельзя — при следующем
            таком же эффекте лишняя неделя могла бы перевернуть значимость. Если хотите
            закладывать такой запас, фиксируйте его в плане до запуска.`,
          }
    );
  }

  // --- срок теста
  const realDuration = actualDuration();
  if (d.daysRecommended > MAX_DAYS) {
    out.push({
      type: 'err',
      h: `Заявленный MDE ${pct(state.mde, 1)} недостижим на этом трафике`,
      b: `Под него нужно ${num(d.need)} наблюдений на вариант — это ${days(
        d.daysForSample
      )}, а максимум ${MAX_DAYS}. Сроком задачу не закрыть. Либо поднимите MDE до ≈${pct(
        d.mdeAchievable,
        1
      )}, либо признайте, что такой тонкий эффект вы не измерите — это честный вывод,`
        + ` а не «изменений нет».`,
    });
  } else if (realDuration < d.daysRecommended) {
    out.push({
      type: 'err',
      h: `Тест короче необходимого: выбрано ${days(realDuration)}, а нужно ${days(
        d.daysRecommended
      )}`,
      b: `Под MDE ${pct(state.mde, 1)} нужно ${num(d.need)} наблюдений на вариант — это ${days(
        d.daysForSample
      )}. Вы набрали ${num(d.bottleneck * realDuration)}. Тест недо-мощен: реальный эффект ${pct(
        trueMde,
        1
      )} он поймал лишь с вероятностью ${pct(
        powerForProportion(d.baseline, trueMde, d.bottleneck * realDuration, state.alpha),
        0
      )}. Вывод «изменений нет» на таких данных нельзя превращать в решение — он означает
      «не хватило данных».`,
    });
  } else if (realDuration > d.daysRecommended + WEEK) {
    out.push({
      type: 'miss',
      h: `Тест длится дольше, чем нужно: выбрано ${days(realDuration)}, а достаточно ${days(
        d.daysRecommended
      )}`,
      b: `Данных хватало ещё на ${days(realDuration - d.daysRecommended)}. Держать эксперимент на живом трафике после получения ответа — это риск (сломается вариант, набегут боты) без выигрыша. Единственная причина ждать дольше — нестабильность
      метрики и повторные сравнения.`,
    });
  } else {
    out.push({
      type: 'ok',
      h: `Срок выбран осмысленно: ${days(d.duration)}`,
      b: `Кратно полной неделе — тест перекрывает недельную цикличность трафика, — и при этом
      достаточен под заявленный MDE (${days(d.daysForSample)}). Это ровно тот баланс, который
      нужен: минимум данных, максимум уверенности.`,
    });
  }

  if (state.shareB < 0.5) {
    out.push({
      type: 'miss',
      h: `На вариант B приходилось только ${pct(state.shareB, 0)} трафика`,
      b: 'Риск выше (меньше данных на B), срок длиннее. Держать 50/50 стоит только ради скорости, а не ради «экономии» на одном варианте.',
    });
  }

  // --- остановка
  if (state.srmStop) {
    out.push({
      type: 'ok',
      h: 'Тест вскрыт на неверной рандомизации — это единственно верное действие',
      b: `В вариант B попало ${pct(snap.shareB, 1)} трафика вместо ${pct(state.shareB, 1)}:
        χ² = ${snap.srm.chi2.toFixed(2)}, p ${formatPExpr(snap.srm.pValue)}. При неверном составе
        групп сравнение метрик бессмысленно, сколько бы убедительными ни выглядели цифры.
        Остановиться и починить бакетер — верно; продолжить и объявить победителя — нет.
        В реальных командах такую остановку делают по раздражителю в мониторинге, а не
        по догадкам: SRM проверяется до чтения метрик.`,
    });
  } else if (state.stoppedAt !== null && state.stoppedAt < state.sim.days.length) {
    const full = primaryResult(scenario, snap);
    const falsePositiveChance = 1 - Math.pow(1 - state.alpha, state.stoppedAt / 3);
    out.push({
      type: 'err',
      h: `Тест остановлен на ${state.stoppedAt}-м дне из ${state.sim.days.length}`,
      b: `Подглядывание в мониторинг ломает статистику: проверок становится много, а значит растёт вероятность ложного
        «победы» — при нулевом эффекте шанс увидеть p &lt; α только за ${state.stoppedAt} дней порядка ${pct(
        falsePositiveChance,
        0
      )}. На полных данных p ${formatPExpr(full.pValue)}. Сначала зафиксируйте срок и размер выборки — и ждите.`,
    });
  } else {
    out.push({
      type: 'ok',
      h: 'Тест доведён до конца',
      b: 'Срок и объём выборки были зафиксированы заранее, а решение принято один раз — это главное правило против подглядывания.',
    });
  }

  // --- SRM
  if (snap.srm.srm) {
    out.push({
      type: state.srmStop ? 'ok' : 'err',
      h: state.srmStop
        ? 'Рандомизация вскрыта, тест остановлен'
        : `Нарушение SRM: в B попало ${pct(snap.shareB, 1)} трафика вместо ${pct(state.shareB, 1)}`,
      b: `χ² = ${snap.srm.chi2.toFixed(2)}, p ${formatPExpr(snap.srm.pValue)}. Обычные причины: баг в рандомайзере,
        несовпадение версий SDK, потеря событий на стороне B. ${
        state.srmStop
          ? 'Вы остановили тест — это ровно то, что здесь требовалось: при неверном составе групп сравнение метрик бессмысленно.'
          : 'Сравнение метрик при SRM бессмысленно — сначала чинить пайплайн, а не читать метрики.'
      }`,
    });
  } else {
    out.push({
      type: 'ok',
      h: 'Распределение трафика корректно',
      b: `χ² = ${snap.srm.chi2.toFixed(2)} — расхождение в пределах случайности. Простая проверка, которая ловит половину поломок до чтения метрик.`,
    });
  }

  // --- гвардрейлы
  const guard = guardrailCheck(scenario, snap);
  if (guard.broken) {
    out.push({
      // Сломанный гвардрейл — это следствие самого изменения, а не ошибка
      // ученика. Раньше он попадал в тип err и пополнял счёт «Ошибок в
      // процессе», хотя верное решение ученика как раз состояло в том, чтобы
      // выкатку заблокировать. Поэтому тип miss: факт зафиксирован, но в
      // список ошибок он не входит.
      type: 'miss',
      h: `Гвардрейл «${METRICS[guard.id].label}» ${fell(guard.id)} на ${signed(guard.res.relLift)}`,
      b: `Случилось само изменение, а не ошибка в вашем плане. Порог, зафиксированный
        до старта, — ${pct(GUARDRAIL_DROP, 0)}. Даже при росте основной метрики такое
        падение блокирует выкатку: классический случай «выкатили красивый график и
        испортили продукт».`,
    });
  } else {
    out.push({
      type: 'ok',
      h: `Гвардрейл в допуске: ${signed(guard.res.relLift)}`,
      b: `Падение меньше порога ${pct(GUARDRAIL_DROP, 0)} — выкатка по основной метрике допустима.`,
    });
  }

  // --- решение
  if (state.decision === expected.action) {
    out.push({
      type: 'ok',
      h: 'Решение соответствует данным',
      b: expected.text.charAt(0).toUpperCase() + expected.text.slice(1) + '.',
    });
  } else {
    out.push({
      type: 'err',
      h: 'Решение не следует из данных',
      b: `Вы выбрали «${
        { ship: 'выкатить B', hold: 'не выкатывать', more: 'продолжить' }[state.decision]
      }», а следовало: ${expected.text}. p-value ${
        primaryResult(scenario, snap).significant ? 'значим' : 'не значим'
      } — а «не значимо» означает «не знаем», а не «работает хуже».`,
    });
  }

  return out;
}

// ============================================================ прогресс и старт

function saveProgress(scenario, correct, issues) {
  try {
    const key = 'ab-sim-progress';
    const all = JSON.parse(localStorage.getItem(key) ?? '{}');
    all[scenario.id] = { correct, issues, at: Date.now() };
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* localStorage может быть недоступен (приватный режим) — это не критично */
  }
}

function screenHome() {
  const progress = loadProgress();
  const cards = SCENARIOS.map((s) => {
    const p = progress[s.id];
    return `<div class="sc" data-id="${s.id}">
      <div class="t">${escapeHtml(s.title)}
        <span class="tag" style="margin-left:8px">сложность ${s.difficulty}</span>
        ${p ? `<span class="tag" style="margin-left:6px">${p.correct ? 'пройден' : 'есть ошибки'}</span>` : ''}
      </div>
      <div class="m">${escapeHtml(s.teaser)}</div>
    </div>`;
  }).join('');

  return `
    <div class="card">
      <h2>Проведи A/B тест сам</h2>
      <p class="lead">Вы берёте на себя роль аналитика: формулируете гипотезу, выбираете метрику,
      считаете размер выборки, следите за экспериментом и принимаете решение о выкатке.
      В конце — разбор каждого решения.</p>
      <p>Данные синтетические, но статистика настоящая: z-тест для долей, t-тест Уэлча для средних,
      SRM-проверка, расчёт MDE и мощности. Всё считается в вашем браузере.</p>
      <h3>Выберите сценарий</h3>
      <div class="scenario-pick">${cards}</div>
    </div>
    <div class="card">
      <h3>Как это устроено</h3>
      <p>Каждый сценарий — это JSON-описание в <code>src/scenarios.js</code>: параметры продукта
      и «правда» о том, что на самом деле произошло с вариантом B. Симуляция детерминирована:
      один и тот же seed всегда даёт одну и ту же историю эксперимента, поэтому результат можно
      обсуждать и повторять.</p>
    </div>`;
}

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem('ab-sim-progress') ?? '{}');
  } catch {
    return {};
  }
}

/** Начинает сценарий с чистого листа: тот же seed — те же данные. */
function startScenario(id) {
  stopTimer();
  state.scenarioId = id;
  state.step = 0;
  state.hypothesis = '';
  state.primary = null;
  state.mde = DEFAULT_MDE;
  state.shareB = DEFAULT_SHARE;
  state.alpha = DEFAULT_ALPHA;
  state.duration = DEFAULT_DAYS;
  state.sim = null;
  state.revealed = 0;
  state.speed = REVEAL_MS;
  state.peekOffered = false;
  state.stoppedAt = null;
state.earlySnap = null;
  state.srmFlagged = false;
  state.srmStop = false;
  state.beforeExtend = null;
  state.extendedDays = 0;
  state.decision = null;
  render();
}

function showHome() {
  stopTimer();
  state.step = 0;
  state.scenarioId = null;
  state.sim = null;
  state.stoppedAt = null;
  state.decision = null;
  state.peekOffered = false;
  state.revealed = 0;

  app.innerHTML = `<div id="screen">${screenHome()}</div>`;
  app.querySelectorAll('.sc').forEach((el) => {
    el.onclick = () => startScenario(el.dataset.id);
  });
}

$('#nav-sim').onclick = (e) => {
  e.preventDefault();
  showHome();
};

showHome();
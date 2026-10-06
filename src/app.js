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
  formatP,
  formatPExpr,
  interpretP,
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

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
 * Проверка гвардрайла: главная метрика может расти, но «сломать» гвардрайл нельзя.
 * Порог падения задан явно (GUARDRAIL_DROP), чтобы решение ученика опиралось
 * на зафиксированное правило, а не на интуицию.
 */
function guardrailCheck(scenario, snap) {
  const id = scenario.guardrails[0] ?? 'arpu';
  const res = metricResult(id, snap);
  return {
    id,
    res,
    broken: res.significant && res.relLift <= -GUARDRAIL_DROP,
    warning: !res.significant && res.relLift <= -GUARDRAIL_DROP,
  };
}

// ============================================================ расчёт дизайна

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
  // поэтому на коротком тесте средний эффект выше
  const trueMde = Math.abs(realizedConversionLift(scenario, duration));

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

  /**
   * Сколько дней нужно, чтобы поймать ИМЕННО ТИПИЧНЫЙ эффект с целевой мощностью.
   * Это другой вопрос, чем «сколько нужно под заявленный MDE»: мощность зависит
   * от объёма данных и размера эффекта, а вовсе не от объявленного порога.
   * Типичный эффект пересчитываем под каждый кандидат — он зависит от срока.
   */
  let daysForTruePower = Infinity;
  for (let cand = MIN_DAYS; cand <= MAX_DAYS * 3; cand += WEEK) {
    const mdeAtCand = Math.abs(realizedConversionLift(scenario, cand));
    if (powerOk(powerForProportion(baseline, mdeAtCand, bottleneck * cand, state.alpha))) {
      daysForTruePower = cand;
      break;
    }
  }
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
    const clsName = i < state.step ? 'done' : i === state.step ? 'now' : '';
    return `<div class="st ${clsName}">${i + 1}. ${title}</div>`;
  }).join('');

  app.innerHTML = `<div class="stepper">${steps}</div><div id="screen"></div>`;
  renderStep();
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

function wireHypothesis() {
  $('#hint1').onclick = () => {
    $('#hyp-msg').innerHTML = `<div class="note">Пример хорошей формулировки:
      «Если заменить текст кнопки оформления на более явный, то <b>конверсия в покупку</b>
      вырастет не менее чем на 5% относительно варианта А, потому что снизится непонимание,
      что произойдёт после клика».</div>`;
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
  const opts = Object.values(METRICS)
    .map(
      (m) => `
      <label class="opt ${state.primary === m.id ? 'sel' : ''}">
        <input type="radio" name="primary" value="${m.id}" ${state.primary === m.id ? 'checked' : ''}>
        <span>
          <span class="t">${escapeHtml(m.label)}</span>
          <span class="d">${escapeHtml(m.hint)}</span>
        </span>
      </label>`
    )
    .join('');

  return `
    <div class="card">
      <h2>Шаг 2. Метрика</h2>
      <p class="lead">Выберите <b>основную метрику</b> — ту, по которой вы примете решение о выкатке.
      Всё остальное — гвардрайлы: их нельзя сломать, даже если основная метрика растёт.</p>
      <div class="options">${opts}</div>
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
    return `<div class="hint up"><b>Срок упёрся в потолок.</b> Под MDE ${pct(state.mde, 1)}
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
      типичный эффект ${pct(d.trueMde, 1)} будет пойман с мощностью ${pct(
      d.powerOnTrueAtRecommended,
      0
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

  const residual = !powerOk(d.powerOnTrue)
    ? ` Но типичный эффект около ${pct(d.trueMde, 1)} этот срок поймает лишь с вероятностью
       ${powerText(d.powerOnTrue)} — это красный вывод ниже. Срок достаточен по вашему MDE,
       но не по реальному эффекту.`
    : '';

  return `<div class="hint ok"><b>✓ По вашему MDE срок достаточен.</b> ${days(chosen)} — кратно полной
      неделе, и данных хватает на порог ${pct(state.mde, 1)} (нужно ${days(d.daysForSample)}).
      Наберётся ${num(d.actualSample)} наблюдений на вариант, надёжно различимый эффект —
      ${pct(d.mdeAchievable, 1)}; типичный эффект ${pct(d.trueMde, 1)} будет пойман
      с мощностью ${powerText(d.powerOnTrue)}.${residual}</div>`;
}

function screenDesign() {
  return `
    <div class="card">
      <h2>Шаг 3. Дизайн теста</h2>
      <p class="lead">Сколько данных нужно, чтобы поймать нужный эффект, и сколько это займёт по времени.
      Подсказки под ползунками подсказывают направление — но итоговое решение остаётся за вами.</p>

      <div class="params">
        <label>MDE — минимальный эффект, ради которого стоит запускать тест:
          <b class="v-label" data-for="mde"></b></label>
        <input type="range" id="mde" min="0.5" max="30" step="0.5">
        <div data-hint="mde"></div>

        <label>Доля трафика на вариант B: <b class="v-label" data-for="share"></b></label>
        <input type="range" id="share" min="10" max="50" step="5">
        <div data-hint="share"></div>

        <label>Длительность теста: <b class="v-label" data-for="duration"></b>
          <span class="muted">(кратно ${WEEK} дням)</span></label>
        <input type="range" id="duration" min="${MIN_DAYS}" max="${MAX_DAYS}" step="${WEEK}">
        <div data-hint="duration"></div>

        <label>Уровень значимости α</label>
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
    <tr class="hl"><td>Мощность на вашем MDE</td>
    <td class="num ${powerOk(d.powerAtChosen) ? 'pos' : 'neg'}">${powerText(d.powerAtChosen)}</td></tr>
    <tr><td>Типичный эффект в этой задаче (о нём вы не знаете)</td>
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
    out.push(
      `<div class="note warn"><b>MDE ${pct(state.mde, 1)} — выше типичного эффекта
      (около ${pct(trueMde, 1)}).</b> Формула тут ни при чём: под ваш заявленный порог данных хватает
      с запасом (мощность ${pct(d.powerAtChosen, 0)}). Проблема в решении. Если реальный эффект
      окажется ${pct(trueMde, 1)}, p-value будет крошечным — изменение статистически значимо,
      но не проходит вашу же планку в ${pct(state.mde, 1)}, и его сворачивают.
      Либо, если данных не хватит, вы честно не заметите эффект и сделаете вывод «изменений нет»,
      хотя он есть.
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
             ${days(d.daysForTruePower)}. На этом трафике эффект ${pct(
              trueMde,
              1
            )} принципиально не измерить — увеличивайте трафик или признайте это ограничение.`
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
  if (state.revealed >= state.sim.days.length) {
    stopTimer();
    state.step = 4;
    render();
    return;
  }
  if (state.revealed >= peekDay(state.sim.days.length) && !state.peekOffered) {
    state.peekOffered = true;
    stopTimer();
    renderStep();
    return;
  }
  renderStep();
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

  const peek = state.peekOffered
    ? `<div class="note bad"><b>Руководитель прибежал с вопросом.</b>
        «Прошло ${peekAt} ${plural(peekAt, ['день', 'дня', 'дней'])} из ${total}, метрики расходятся — может, выкатим?»
        <div class="row">
          <button class="danger" id="stopNow">Остановить тест и объявить победителя</button>
          <button class="primary" id="keepGoing">Продолжить до конца</button>
        </div>
        <p style="margin-bottom:0">Соблазн велик: p-value уже на экране, и он выглядит
        убедительно. Но это решение опирается на ${shareText} будущего результата —
        данные за ${days(peekAt)} из ${total}. Каждая такая проверка в середине теста —
        дополнительная попытка поймать шум, и именно она порождает ложные открытия.
        Срок и объём выборки были зафиксированы до старта: дождаться конца стоит
        бесплатно, а вот пересмотреть план задним числом — нет.</p></div>`
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
        ${metricRow('ctr', snap, state.primary === 'ctr')}
        ${metricRow('conversion', snap, state.primary === 'conversion')}
        ${metricRow('arpu', snap, state.primary === 'arpu')}
        <tr>
          <td>Распределение трафика (SRM)</td>
          <td class="num">${pct(1 - snap.shareB, 1)}</td>
          <td class="num">${pct(snap.shareB, 1)}</td>
          <td class="num ${snap.srm.srm ? 'neg' : 'muted'}">χ²=${snap.srm.chi2.toFixed(2)}</td>
          <td class="num ${snap.srm.srm ? 'neg' : 'muted'}">${snap.srm.srm ? 'нарушение' : 'ок'}</td>
        </tr>
      </table>
      ${
        guard.broken
          ? `<div class="note bad"><b>Гвардрайл сломан.</b> «${escapeHtml(
              METRICS[guard.id].label
            )}» упал на ${signed(guard.res.relLift)} — это больше зафиксированного порога
            ${pct(GUARDRAIL_DROP, 0)}. По заранее согласованному правилу такую выкатку не проводят,
            сколько бы ни выросла основная метрика.</div>`
          : ''
      }
      ${
        snap.srm.srm
          ? `<div class="note bad"><b>Sample Ratio Mismatch.</b> Доли трафика не сходятся с
        настройкой. Так бывает, когда бакетер отдаёт часть пользователей только одному варианту
        (баг, фильтр, различия в клиентском SDK). Дальше считать эффект бессмысленно — сначала чинить.</div>`
          : ''
      }
      <div class="note">По выбранной основной метрике (<b>${escapeHtml(
        METRICS[state.primary].label
      )}</b>): изменение ${signed(res.relLift)}, p ${formatPExpr(res.pValue)} — ${interpretP(res.pValue)}.</div>
      ${peek}
      <div class="row">
        <button id="fast" ${state.timer ? '' : 'disabled'}>Ускорить ×5</button>
      </div>
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

/** Строка таблицы для одной метрики: значения A/B, изменение и p-value. */
function metricRow(metricId, snap, isPrimary) {
  const res = metricResult(metricId, snap);
  const isMean = metricId === 'arpu';
  const fmt = isMean ? money : (v) => pct(v);
  const valA = isMean ? res.meanA : res.pa;
  const valB = isMean ? res.meanB : res.pb;
  return `<tr${isPrimary ? ' class="hl"' : ''}>
          <td>${escapeHtml(METRICS[metricId].label)}${isPrimary ? ' — основная' : ''}</td>
          <td class="num">${fmt(valA)}</td>
          <td class="num">${fmt(valB)}</td>
          <td class="num ${cls(res.relLift)}">${signed(res.relLift)}</td>
          <td class="num">${formatP(res.pValue)}</td>
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
  const early = state.stoppedAt !== null && state.stoppedAt < state.sim.days.length;

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

  return `
    <div class="card">
      <h2>Шаг 5. Решение</h2>
      <p class="lead">Все ${state.revealed} дней собраны. Что делаем с вариантом B?</p>
      ${earlyBlock}
      ${resultTable(scenario, snap)}
      <h3>Итог статистики</h3>
      <div class="grid2">
        <div>
          <div class="kpi"><span>Основная метрика</span><span class="v">${escapeHtml(
            METRICS[state.primary].label
          )}</span></div>
          <div class="kpi"><span>Изменение</span><span class="v ${cls(res.relLift)}">${signed(res.relLift)}</span></div>
          <div class="kpi"><span>95% ДИ на Δ</span><span class="v">${pct(res.ci[0])} … ${pct(res.ci[1])}</span></div>
          <div class="kpi"><span>p-value</span><span class="v">${formatP(res.pValue)}</span></div>
          <div class="kpi"><span>Вывод при α = ${state.alpha}</span><span class="v ${
            res.significant ? 'pos' : 'muted'
          }">${res.significant ? 'значимо' : 'не значимо'}</span></div>
        </div>
        <div>
          <div class="kpi"><span>Выборка A / B</span><span class="v">${num(snap.t.visitors.A)} / ${num(
          snap.t.visitors.B
        )}</span></div>
          <div class="kpi"><span>Гвардрайл: ${escapeHtml(METRICS[guard.id].label)}</span>
            <span class="v ${guard.broken ? 'neg' : cls(guard.res.relLift)}">${signed(guard.res.relLift)}</span></div>
          <div class="kpi"><span>Гвардрайл p-value</span><span class="v">${formatP(guard.res.pValue)}</span></div>
          <div class="kpi"><span>Порог падения гвардрайла</span>
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
          ? `<div class="note bad">По заранее зафиксированному правилу гвардрайл важнее основной метрики:
             падение «${escapeHtml(METRICS[guard.id].label)}» на ${signed(
            guard.res.relLift
          )} блокирует выкатку.</div>`
          : ''
      }
      <div class="row">
        <button class="primary" data-dec="ship">Выкатить вариант B</button>
        <button data-dec="hold">Не выкатывать, вернуть к A</button>
        <button data-dec="more">Продолжить тест ещё на 7 дней</button>
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
        const extra = state.sim.days.slice(state.revealed, state.revealed + 7);
        state.sim.days = state.sim.days.concat(extra);
        state.sim.total = aggregate(state.sim.days);
        state.revealed += 7;
        renderStep();
        return;
      }
      state.decision = btn.dataset.dec;
      state.step = 5;
      render();
    };
  });
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
        <tr><td>Гвардрайл «выручка на сессию»</td>
        <td class="num ${cls(finalSnap.arpu.relLift)}">${signed(finalSnap.arpu.relLift)}
        (p ${formatPExpr(finalSnap.arpu.pValue)})</td></tr>
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
      <div class="row">
        <button class="primary" id="restart">Пройти заново</button>
        <button id="other">Другой сценарий</button>
      </div>
    </div>`;
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
        + `но гвардрайл «${METRICS[guard.id].label}» упал на ${signed(guard.res.relLift)} — `
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
  const trueMde = Math.abs(realizedConversionLift(scenario));

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
  if (scenario.goodPrimary.includes(state.primary)) {
    out.push({
      type: 'ok',
      h: 'Основная метрика выбрана верно',
      b: `«${METRICS[state.primary].label}» отражает ценность изменения, а гвардрайл «${scenario.guardrails
        .map((g) => METRICS[g].label)
        .join('», «')}» не даст выкатить вредный вариант.`,
    });
  } else {
    const proxyLift = snap.ctr.relLift;
    const bizLift = Math.abs(snap.conv.relLift);
    out.push({
      type: 'err',
      h: 'Основная метрика выбрана неверно',
      b: `Следовало смотреть на «${scenario.goodPrimary
        .map((g) => METRICS[g].label)
        .join('», «')}». «${METRICS[state.primary].label}» — прокси: в этом тесте она изменилась на
        ${signed(proxyLift)}, а бизнес-метрика — лишь на ${signed(snap.conv.relLift)}.
        Решение по прокси-метрике почти всегда отделяется от решения по деньгам.`,
    });
  }

  // --- дизайн
  const d = design();
  if (state.mde > trueMde * 2) {
    out.push({
      type: 'err',
      h: `MDE завышен в ${(state.mde / trueMde).toFixed(1)} раза`,
      b: `Вы объявили порог ${pct(state.mde, 1)}, а типичный эффект здесь около ${pct(trueMde, 1)}.
        Тест закончен формально (под заявленный MDE мощность ${pct(d.powerAtNeeded, 0)}), но настоящий
        эффект он заметил бы лишь с вероятностью ${pct(d.powerOnTrue, 0)}. Такой тест не имеет права
        делать вывод «эффекта нет» — он просто его не видел.`,
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

  // --- срок теста
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
  } else if (d.duration < d.daysRecommended) {
    out.push({
      type: 'err',
      h: `Тест короче необходимого: выбрано ${days(d.duration)}, а нужно ${days(
        d.daysRecommended
      )}`,
      b: `Под MDE ${pct(state.mde, 1)} нужно ${num(d.need)} наблюдений на вариант — это ${days(
        d.daysForSample
      )}. Вы набрали ${num(d.actualSample)}. Тест недо-мощен: реальный эффект ${pct(
        trueMde,
        1
      )} он поймал лишь с вероятностью ${pct(d.powerOnTrue, 0)}. Вывод «изменений нет» на таких данных
      нельзя превращать в решение — он означает «не хватило данных».`,
    });
  } else if (d.duration > d.daysRecommended + WEEK) {
    out.push({
      type: 'miss',
      h: `Тест длится дольше, чем нужно: выбрано ${days(d.duration)}, а достаточно ${days(
        d.daysRecommended
      )}`,
      b: `Данных хватало ещё на ${days(
        d.duration - d.daysRecommended
      )}. Держать эксперимент на живом трафике после получения ответа — это риск (сломается
      вариант, набегут боты) без выигрыша. Единственная причина ждать дольше — нестабильность
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
  if (state.stoppedAt !== null && state.stoppedAt < state.sim.days.length) {
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
      type: 'err',
      h: `Нарушение SRM: в B попало ${pct(snap.shareB, 1)} трафика вместо ${pct(state.shareB, 1)}`,
      b: `χ² = ${snap.srm.chi2.toFixed(2)}, p ${formatPExpr(snap.srm.pValue)}. Обычные причины: баг в рандомайзере,
        несовпадение версий SDK, потеря событий на стороне B. Сравнение метрик при SRM бессмысленно — сначала чинить пайплайн.`,
    });
  } else {
    out.push({
      type: 'ok',
      h: 'Распределение трафика корректно',
      b: `χ² = ${snap.srm.chi2.toFixed(2)} — расхождение в пределах случайности. Простая проверка, которая ловит половину поломок до чтения метрик.`,
    });
  }

  // --- гвардрайлы
  const guard = guardrailCheck(scenario, snap);
  if (guard.broken) {
    out.push({
      type: 'err',
      h: `Гвардрайл «${METRICS[guard.id].label}» упал на ${signed(guard.res.relLift)}`,
      b: `Порог, зафиксированный до старта, — ${pct(GUARDRAIL_DROP, 0)}. Даже при росте основной метрики
        такое падение блокирует выкатку: классический случай «выкатили красивый график и испортили продукт».`,
    });
  } else {
    out.push({
      type: 'ok',
      h: `Гвардрайл в допуске: ${signed(guard.res.relLift)}`,
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
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
const REVEAL_MS = 260;
const PEEK_DAY = 7; // на какой день «менеджер прибегает с вопросом»

const state = {
  scenarioId: null,
  step: 0,
  hypothesis: '',
  primary: null,
  mde: 0.05,
  shareB: 0.5,
  alpha: 0.05,
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

function design() {
  const scenario = getScenario(state.scenarioId);
  const baseline = scenario.baselineConversion;
  const perVariant = {
    A: Math.round(scenario.trafficPerDay * (1 - state.shareB)),
    B: Math.round(scenario.trafficPerDay * state.shareB),
  };
  const need = sampleSizeProportion(baseline, state.mde, POWER_TARGET, state.alpha);
  const daysNeeded = durationDays(need, perVariant.B);
  const power = powerForProportion(baseline, state.mde, need, state.alpha);
  return { baseline, perVariant, need, daysNeeded, power, scenario };
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

function screenDesign() {
  const scenario = getScenario(state.scenarioId);
  const d = design();
  const mdePercent = (state.mde * 100).toFixed(1);
  const sharePercent = (state.shareB * 100).toFixed(0);

  return `
    <div class="card">
      <h2>Шаг 3. Дизайн теста</h2>
      <p class="lead">Сколько данных нужно, чтобы поймать нужный эффект, и сколько это займёт по времени.</p>

      <label>MDE — минимальный эффект, ради которого стоит запускать тест: <b id="mdeLabel">${mdePercent}%</b></label>
      <input type="range" id="mde" min="0.5" max="30" step="0.5" value="${mdePercent}">

      <label>Доля трафика на вариант B: <b id="shareLabel">${sharePercent}%</b> (A получит ${100 - Number(sharePercent)}%)</label>
      <input type="range" id="share" min="10" max="50" step="5" value="${sharePercent}">

      <label>Уровень значимости α</label>
      <select id="alpha">
        <option value="0.05" ${state.alpha === 0.05 ? 'selected' : ''}>0.05 — стандарт</option>
        <option value="0.01" ${state.alpha === 0.01 ? 'selected' : ''}>0.01 — строже, нужно больше данных</option>
        <option value="0.1" ${state.alpha === 0.1 ? 'selected' : ''}>0.10 — нестрого, много ложных побед</option>
      </select>

      <h3>Расчёт</h3>
      <table>
        <tr><td>Базовая конверсия</td><td class="num">${pct(d.baseline)}</td></tr>
        <tr><td>Нужная конверсия B при ${mdePercent}%</td><td class="num">${pct(d.baseline * (1 + state.mde))}</td></tr>
        <tr><td>Размер выборки на вариант</td><td class="num">${num(d.need)}</td></tr>
        <tr><td>Трафик в вариант B в день</td><td class="num">${num(d.perVariant.B)}</td></tr>
        <tr class="hl"><td>Срок теста</td><td class="num">≈ ${d.daysNeeded} дн.</td></tr>
        <tr><td>Мощность при таком MDE</td><td class="num">${pct(d.power, 1)}</td></tr>
        <tr><td>Реальный MDE при этом размере выборки</td><td class="num">${pct(
          mdeForProportion(d.baseline, d.need, POWER_TARGET, state.alpha),
          2
        )}</td></tr>
      </table>
      <div id="design-msg"></div>
      <div class="row">
        <button class="primary" id="run">Запустить тест на ${scenario.durationDays} дней →</button>
        <button id="reset">Сбросить</button>
      </div>
    </div>`;
}

function designWarnings() {
  const scenario = getScenario(state.scenarioId);
  const d = design();
  const out = [];
  // Знак эффекта не важен для оценки MDE — важен его размер
  const trueMde = Math.abs(realizedConversionLift(scenario));

  if (state.mde < trueMde / 3) {
    const ratio = (trueMde / state.mde) ** 2;
    out.push(
      `<div class="note warn">MDE ${pct(state.mde, 1)} в ${(trueMde / state.mde).toFixed(
        1
      )} раза мельче, чем типичный эффект в этой задаче. Тест станет в ~${ratio.toFixed(
        0
      )} раз длиннее при том же риске. Формула чувствительна к квадрату MDE: уменьшение в 2 раза = ×4 по трафику.</div>`
    );
  }
  if (state.mde > trueMde * 2) {
    out.push(
      `<div class="note warn">Вы объявили MDE ${pct(state.mde, 1)}, а типичный эффект здесь около
      ${pct(trueMde, 1)}. Мощность ${pct(d.power, 1)} вместо ${pct(POWER_TARGET, 0)}:
      реальный эффект вы можете <b>не заметить</b> и сделать ложный вывод «изменений нет».</div>`
    );
  }
  if (state.shareB < 0.5) {
    out.push(
      `<div class="note">Доля B = ${pct(state.shareB, 0)}. Это законно, но вариант B будет копить данные
      в ${(0.5 / state.shareB).toFixed(1)} раза медленнее — тест растянется на ${d.daysNeeded} дней.</div>`
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
    out.push(`<div class="note good">Расчёт выглядит разумным: мощность ${pct(d.power, 1)},
      срок ≈ ${d.daysNeeded} дн. Запускайте.</div>`);
  }
  return out.join('');
}

function wireDesign() {
  const upd = () => {
    state.mde = Number($('#mde').value) / 100;
    state.shareB = Number($('#share').value) / 100;
    const keepScroll = window.scrollY;
    renderStep();
    window.scrollTo(0, keepScroll);
  };
  $('#mde').oninput = upd;
  $('#share').oninput = upd;
  $('#alpha').onchange = (e) => {
    state.alpha = Number(e.target.value);
    renderStep();
  };
  $('#reset').onclick = () => {
    state.mde = 0.05;
    state.shareB = 0.5;
    state.alpha = 0.05;
    renderStep();
  };
  $('#design-msg').innerHTML = designWarnings();
  $('#run').onclick = () => startExperiment();
}

function startExperiment() {
  const scenario = getScenario(state.scenarioId);
  state.sim = runExperiment(scenario, { shareB: state.shareB });
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
  if (state.revealed >= PEEK_DAY && !state.peekOffered) {
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
  const total = scenario.durationDays;

  const peek = state.peekOffered
    ? `<div class="note bad"><b>${escapeHtml('Руководитель прибежал с вопросом')}:</b>
        «Прошло ${PEEK_DAY} дней, метрики расходятся — может, выкатим?»
        <div class="row">
          <button class="danger" id="stopNow">Остановить тест и объявить победителя</button>
          <button class="primary" id="keepGoing">Продолжить до конца</button>
        </div>
        <p style="margin-bottom:0">Посмотрите на p-value выше. Оно уже «значимо» — но так будет
        почти всегда, если смотреть в мониторинг слишком долго.</p></div>`
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
      .map(
        (d, i) =>
          `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="#6b7887" font-size="11"
            text-anchor="middle">${d.day + 1}</text>`
      )
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
  if (state.mde > trueMde * 2) {
    const p = powerForProportion(scenario.baselineConversion, state.mde, design().need, state.alpha);
    out.push({
      type: 'err',
      h: `MDE завышен в ${(state.mde / trueMde).toFixed(1)} раза`,
      b: `Мощность теста ${pct(p, 0)} против целевых 80%. Такой тест не имеет права делать вывод «эффекта нет» — он просто не видел эффект.`,
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
      b: `${pct(state.mde, 1)} — разумная граница значимости для этой задачи, мощность около ${pct(
        design().power,
        0
      )}.`,
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
    el.onclick = () => {
      state.scenarioId = el.dataset.id;
      state.step = 0;
      state.hypothesis = '';
      state.primary = null;
      state.mde = 0.05;
      state.shareB = 0.5;
      state.alpha = 0.05;
      state.stoppedAt = null;
      state.decision = null;
      state.speed = REVEAL_MS;
      render();
    };
  });
}

$('#nav-sim').onclick = (e) => {
  e.preventDefault();
  showHome();
};

showHome();
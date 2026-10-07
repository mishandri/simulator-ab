// Аудит сценариев: ищем логические противоречия между экранами.
// Запуск в консоли страницы приложения:
//   import('/tools/audit.js').then(m => m.run())
// Страница должна быть перечитана перед вызовом (см. reset ниже).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const doc = () => document;

function click(sel) {
  const el = doc().querySelector(sel);
  if (!el) throw new Error('нет элемента: ' + sel);
  el.click();
}

async function waitFor(sel, n = 60) {
  for (let i = 0; i < n; i++) {
    const el = doc().querySelector(sel);
    if (el) return el;
    await sleep(100);
  }
  const h2 = doc().querySelector('h2');
  throw new Error('не дождался: ' + sel + ' (шаг «' + (h2 ? h2.innerText : 'главная') + '»)');
}

async function waitStep(title, n = 60) {
  for (let i = 0; i < n; i++) {
    const h2 = doc().querySelector('h2');
    if (h2 && h2.innerText === title) return;
    await sleep(100);
  }
  throw new Error('не дождался шага: ' + title);
}

const text = () => doc().querySelector('#screen').innerText;
const has = (s) => text().indexOf(s) >= 0;

/** Прогон сценария до конца. Возвращает снимок состояния по шагам. */
async function play({ scenario, metric, mde, share, duration, stopEarly = false, decision = 'hold' }) {
  // Каждый прогон начинается с главной страницы: предыдущий закончил на разборе
  click('#nav-sim');
  await waitFor('.sc[data-id=' + scenario + ']');
  click('.sc[data-id=' + scenario + ']');
  await waitFor('#hyp');
  doc().querySelector('#hyp').value =
    'Если изменить интерфейс магазина, то конверсия в покупку вырастет не менее чем на 5%';
  click('#next1');
  await waitFor('input[value=' + metric + ']');
  doc().querySelector('input[value=' + metric + ']').click();
  await sleep(250);
  click('#next2');
  await waitFor('#mde');
  if (mde !== undefined) {
    const m = doc().querySelector('#mde');
    m.value = mde;
    m.dispatchEvent(new Event('input'));
  }
  if (share !== undefined) {
    const s = doc().querySelector('#share');
    s.value = share;
    s.dispatchEvent(new Event('input'));
  }
  if (duration !== undefined) {
    const d = doc().querySelector('#duration');
    d.value = duration;
    d.dispatchEvent(new Event('input'));
  }

  const design = {
    hints: [...doc().querySelectorAll('[data-hint]')].map((h) => h.className.replace('hint ', '')),
    notes: [...doc().querySelectorAll('#design-msg .note')].map((n) => n.className.replace('note ', '')),
    mdeLabel: doc().querySelector('[data-for="mde"]').textContent,
    powerOnTrue: (text().match(/Мощность на типичном эффекте\s+([\d.]+%)/) || [])[1],
    mdeAchievable: (text().match(/надёжно отличит от нуля\s+([\d.]+%)/) || [])[1],
    teachingNote: has('Что здесь специального'),
  };

  click('#run');
  // Ждём либо ловушку руководителя, либо остановку из-за SRM, либо конец
  for (let i = 0; i < 100; i++) {
    if (
      doc().querySelector('#keepGoing') ||
      doc().querySelector('#stopNow') ||
      doc().querySelector('[data-dec]')
    ) {
      break;
    }
    await sleep(100);
  }

  const observe = {
    day: (text().match(/Идёт (\d+) из (\d+)/) || []).slice(1).join('/'),
    srmStopOffered: !!doc().querySelector('#stopNow'),
    managerPeek: !!doc().querySelector('#keepGoing'),
    pDashes: doc().querySelectorAll('table td.num').length > 0 && has('—'),
    noteClasses: [...doc().querySelectorAll('.note.bad, .note.warn, .note.good')].map(
      (n) => n.className.replace('note ', '')
    ),
  };

  // При SRM прогон останавливается сам и предлагает только остановку —
  // нажать «остановить из-за SRM» нужно в любом случае
  if (doc().querySelector('#stopNow')) click('#stopNow');
  else if (doc().querySelector('#keepGoing')) click('#keepGoing');
  for (let i = 0; i < 200 && !doc().querySelector('[data-dec]'); i++) await sleep(100);

  const decisionStep = {
    metricError: !!doc().querySelector('#back-metric'),
    stepper: [...doc().querySelectorAll('.kpi')].map((k) => k.innerText.replace(/\s+/g, ' ')),
    buttons: [...doc().querySelectorAll('[data-dec]')].map((b) => b.dataset.dec),
  };

  click('[data-dec=' + decision + ']');
  const debrief = {
    verdict: doc().querySelector('.note').innerText.split('\n')[0].slice(0, 90),
    issues: [...doc().querySelectorAll('.issue')].map(
      (i) => i.className.replace('issue ', '') + ': ' + i.querySelector('.h').innerText
    ),
    hasUnmeasurableNote: has('не дал ответа'),
    hasUnreachablePower: has('Отвергнуть H0 нельзя'),
    dirty: (text().match(/Infinity|NaN|undefined/g) || []).length,
  };

  return { design, observe, decisionStep, debrief };
}

/** Список метрик на шаге выбора: что доступно и что заблокировано. */
async function listMetrics() {
  click('#nav-sim');
  await waitFor('.sc[data-id=checkout-button]');
  click('.sc[data-id=checkout-button]');
  await waitFor('#hyp');
  doc().querySelector('#hyp').value =
    'Если изменить интерфейс магазина, то конверсия в покупку вырастет не менее чем на 5%';
  click('#next1');
  await waitFor('.opt');
  const opts = [...doc().querySelectorAll('.opt')].map(
    (o) =>
      o.className.replace('opt ', '') +
      ': ' +
      o.querySelector('.t').innerText.replace(/\s+/g, ' ') +
      ' | disabled=' +
      o.querySelector('input').disabled
  );
  return {
    design: { opts },
    observe: {},
    decisionStep: {},
    debrief: { verdict: opts.join('\n           ') },
  };
}

export async function run() {
  const report = [];

  // ---- Сценарий 1: корректный путь
  report.push(
    ['кейс 1 / правильная метрика', await play({ scenario: 'checkout-button', metric: 'conversion' })]
  );

  // ---- Сценарий 2: правильный путь
  report.push(
    ['кейс 2 / правильная метрика', await play({ scenario: 'free-shipping', metric: 'arpu' })]
  );

  // ---- Сценарий 3: правильный путь
  report.push(['кейс 3 / правильная метрика', await play({ scenario: 'broken-randomizer', metric: 'arpu' })]);

  // ---- Подозрительные места
  // «Время на сайте» больше нельзя выбрать: метрика не моделируется,
  // и раньше под её названием показывались данные конверсии
  report.push(['доступные метрики', await listMetrics()]);
  // Ранняя остановка бывает только там, где нет SRM: в кейсе 3 прогон
  // останавливается сам, ловушки руководителя там не случается
  report.push(
    [
      'кейс 1 / ранняя остановка',
      await play({ scenario: 'checkout-button', metric: 'conversion', stopEarly: true }),
    ]
  );
  report.push(
    [
      'кейс 3 / прокси CTR (ожидаем ошибку метрики)',
      await play({ scenario: 'broken-randomizer', metric: 'ctr' }),
    ]
  );

  const lines = [];
  for (const [name, r] of report) {
    lines.push('### ' + name);
    if (!r.design.hints) {
      lines.push('           ' + r.debrief.verdict);
      lines.push('');
      continue;
    }
    lines.push('  дизайн: подсказки=' + r.design.hints.join('/') + ' выводы=' + (r.design.notes.join(',') || '—'));
    lines.push(
      '           MDE=' +
        r.design.mdeLabel +
        ' мощность на типичном=' +
        r.design.powerOnTrue +
        ' различимый эффект=' +
        r.design.mdeAchievable +
        ' заметка=' +
        r.design.teachingNote
    );
    lines.push(
      '  наблюдение: день=' +
        r.observe.day +
        ' SRM-остановка=' +
        r.observe.srmStopOffered +
        ' ловушка руководителя=' +
        r.observe.managerPeek +
        ' p заменён на прочерк=' +
        r.observe.pDashes
    );
    lines.push(
      '  решение: ошибка метрики=' + r.decisionStep.metricError + ' кнопки=' + r.decisionStep.buttons.join(',')
    );
    lines.push('  разбор: ' + r.debrief.verdict);
    lines.push('           ' + r.debrief.issues.join('\n           '));
    lines.push(
      '           заметка о неизмеримости=' +
        r.debrief.hasUnmeasurableNote +
        ' | H0-отказ=' +
        r.debrief.hasUnreachablePower +
        ' | мусор=' +
        r.debrief.dirty
    );
    lines.push('');
  }
  return lines.join('\n');
}

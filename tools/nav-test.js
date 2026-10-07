// Проверка навигации по степперу. Запускается в консоли страницы приложения:
//   import('/tools/nav-test.js').then(m => m.run())
// Работает с текущим документом, поэтому шаги и состояние — настоящие.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const doc = () => document;

function click(sel) {
  const el = doc().querySelector(sel);
  if (!el) throw new Error('нет элемента: ' + sel);
  el.click();
  return el;
}

async function waitFor(sel, n = 50) {
  for (let i = 0; i < n; i++) {
    const el = doc().querySelector(sel);
    if (el) return el;
    await sleep(100);
  }
  const h2 = doc().querySelector('h2');
  throw new Error('не дождался: ' + sel + ' (сейчас шаг «' + (h2 ? h2.innerText : '?') + '»)');
}

const step = () => {
  const h2 = doc().querySelector('h2');
  return h2 ? h2.innerText : '(главная страница)';
};

/**
 * Полный сброс приложения.
 * Страницу нужно перечитать ДО вызова run() — изнутри страницы reload()
 * уничтожает контекст выполнения, и ожидание load уже не на чём сработает.
 */
export async function reset() {
  window.location.reload();
}

export async function run() {
  const log = [];
  try {
    return await scenario(log);
  } catch (e) {
    // Лог собираем даже при сбое: он показывает, на каком шаге остановились
    return log.join('\n') + '\n\nОШИБКА: ' + (e && e.message ? e.message : e);
  }
}

async function scenario(log) {

  // Страница должна быть перечитана через reset() перед вызовом run()
  await waitFor('.sc[data-id=checkout-button]');
  click('.sc[data-id=checkout-button]');

  await waitFor('#hyp');
  log.push('1) ' + step());

  doc().querySelector('#hyp').value =
    'Если изменить главную страницу магазина, то конверсия в покупку вырастет не менее чем на 5%';
  click('#next1');
  await waitFor('input[value=conversion]');
  log.push('2) ' + step());

  const radio = doc().querySelector('input[value=conversion]');
  radio.click();
  await sleep(300);
  log.push(
    'после клика по радио: checked=' +
      radio.checked +
      ' | на экране checked=' +
      doc().querySelector('input[value=conversion]').checked +
      ' | элемент тот же: ' +
      (radio === doc().querySelector('input[value=conversion]'))
  );
  click('#next2');
  await waitFor('#mde');
  log.push('3) ' + step());

  const mde = doc().querySelector('#mde');
  mde.value = 7;
  mde.dispatchEvent(new Event('input'));
  await waitFor('.st.back');
  log.push('MDE подкручен: ' + doc().querySelector('#mde').value + '%');
  log.push('кликабельных шагов назад: ' + doc().querySelectorAll('.st.back').length);

  // Назад на шаг 2
  click('.st.back[data-step="1"]');
  await waitFor('input[value=conversion]');
  log.push('назад → ' + step());
  log.push('выбор метрики сброшен: ' + !doc().querySelector('input[value=conversion]').checked);

  // Вперёд снова на дизайн. После возврата на шаг 2 метрика не выбрана,
  // поэтому сначала выбираем её заново — так же, как это делает пользователь.
  const radio2 = doc().querySelector('input[value=conversion]');
  radio2.click();
  await sleep(300);
  click('#next2');
  await waitFor('#mde');
  log.push(
    'вперёд → MDE=' +
      doc().querySelector('#mde').value +
      '% трафик=' +
      doc().querySelector('#share').value +
      '% срок=' +
      doc().querySelector('#duration').value +
      ' дн.'
  );

  // Назад на шаг 1 — текст гипотезы должен сохраниться
  click('.st.back[data-step="0"]');
  await waitFor('#hyp');
  log.push('назад на шаг 1 → ' + step());
  log.push('текст гипотезы сохранён: «' + doc().querySelector('#hyp').value.slice(0, 34) + '…»');

  // Недоступные шаги не кликабельны
  const clickable = doc().querySelectorAll('.st.back').length;
  const total = doc().querySelectorAll('.st').length;
  log.push('кликабельных шагов: ' + clickable + ' из ' + total);

  // Возврат на главную
  click('#nav-sim');
  await waitFor('.sc[data-id=checkout-button]');
  log.push('на главной: ' + step());
  log.push('кликабельных шагов на главной: ' + doc().querySelectorAll('.st.back').length);

  return log.join('\n');
}

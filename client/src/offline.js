/**
 * Гарантия офлайн-запуска.
 *
 * Регистрации service worker недостаточно. При самом первом открытии страница
 * успевает загрузить весь свой код до того, как worker начинает её
 * контролировать, — значит, в кэш эти файлы не попадают, и следующий запуск
 * уже без связи заканчивается пустым экраном. Ровно тот случай, который на
 * демо выглядит как «прототип развалился».
 *
 * Поэтому после активации мы сами перечисляем worker'у всё, что страница
 * фактически загрузила, и просим положить это в кэш. Работает одинаково в
 * dev-режиме с отдельными модулями и в собранной сборке.
 */

function collectLoadedUrls() {
  const urls = new Set([location.href]);
  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const url = new URL(entry.name);
      // Тайлы карты кэширует отдельная стратегия, /api не кэшируем никогда.
      if (url.origin !== location.origin) continue;
      if (url.pathname.startsWith('/api/')) continue;
      urls.add(url.href);
    } catch {
      /* запись без разбираемого адреса — пропускаем */
    }
  }
  return [...urls];
}

function askToPrecache() {
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;
  worker.postMessage({ type: 'precache', urls: collectLoadedUrls() });
}

export function enableOfflineStart() {
  if (!('serviceWorker' in navigator)) {
    console.warn('service worker недоступен, офлайн-запуск не гарантирован');
    return;
  }

  navigator.serviceWorker.register('/sw.js').catch(() => {
    console.warn('service worker не зарегистрирован, офлайн-запуск не гарантирован');
  });

  // Первый запуск: worker перехватывает управление уже после загрузки кода.
  navigator.serviceWorker.addEventListener('controllerchange', askToPrecache);

  // Последующие запуски и модули, подгруженные лениво (карта, например).
  navigator.serviceWorker.ready.then(() => {
    askToPrecache();
    setTimeout(askToPrecache, 3_000);
  });
}

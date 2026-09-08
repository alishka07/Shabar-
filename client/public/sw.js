/**
 * Service worker.
 *
 * Две задачи, обе про режим полёта:
 *  1. Оболочка приложения открывается без сети, включая первый запуск после
 *     установки на чужом телефоне.
 *  2. Тайлы карты, которые уже видели, остаются доступными офлайн.
 *
 * Запросы к /api сюда не заворачиваются вообще: очередь синхронизации сама
 * решает, когда и что отправлять, и кэш ей только помешал бы.
 */

const SHELL_CACHE = 'khabar-shell-v1';
const TILE_CACHE = 'khabar-tiles-v1';

const SHELL = ['/', '/index.html', '/dashboard.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Часть путей в dev-режиме отдаётся Vite и может не существовать как файл,
      // поэтому кладём что получится, а не падаем на первой же ошибке.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== SHELL_CACHE && name !== TILE_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Страница присылает список того, что она реально загрузила.
 *
 * Это и закрывает дыру первого запуска: при самом первом открытии код успевает
 * загрузиться раньше, чем worker берёт вкладку под контроль, и без такого
 * списка в кэш он бы не попал.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'precache') return;
  event.waitUntil(precacheMissing(event.data.urls));
});

/**
 * Кладёт в кэш только то, чего там ещё нет.
 *
 * `cache.add` перекачивает файл, даже если он уже лежит. Среда выполнения
 * распознавания речи весит 14 МБ, и без этой проверки каждый запуск приложения
 * при связи тянул бы её заново — ровно то расточительство канала, против
 * которого весь проект.
 */
async function precacheMissing(urls) {
  const cache = await caches.open(SHELL_CACHE);
  const missing = [];
  for (const url of urls) {
    if (!(await cache.match(url, { ignoreVary: true }))) missing.push(url);
  }
  await Promise.allSettled(missing.map((url) => cache.add(url)));
}

function isTile(url) {
  return /tile\.openstreetmap\.org/.test(url.hostname) || /\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  if (isTile(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

/** Тайл не меняется. Один раз скачали — дальше отдаём из кэша, даже в поле. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response('', { status: 504, statusText: 'tile unavailable offline' });
  }
}

/** Код приложения обновляем при связи, но никогда не остаёмся без него. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cacheLookup(cache, request);
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    throw error;
  }
}

/**
 * Поиск в кэше с двумя послаблениями. Оба нужны, оба безопасны.
 *
 * `ignoreVary` — потому что в кэш файл кладём мы сами, из worker'а, а просит
 * его страница. Заголовки запросов разные, и сервер, ответивший `Vary`,
 * заставил бы кэш промахнуться на файле, который в нём лежит.
 *
 * `ignoreSearch` — из-за dev-режима: Vite дописывает к модулям метку вида
 * `?t=1788843474573` при горячей перезагрузке, и после перезапуска без связи
 * страница просит другой адрес того же файла. В собранной сборке версия зашита
 * в имя файла, так что здесь это ни на что не влияет.
 */
async function cacheLookup(cache, request) {
  return (
    (await cache.match(request, { ignoreVary: true })) ||
    cache.match(request, { ignoreSearch: true, ignoreVary: true })
  );
}

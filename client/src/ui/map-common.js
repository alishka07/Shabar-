import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { DEFAULT_CENTER, DEFAULT_ZOOM, TILE_ATTRIBUTION, TILE_URL } from '../config.js';

/**
 * Карта на Leaflet.
 *
 * Тайлы кэширует service worker (см. public/sw.js), поэтому уже просмотренный
 * район открывается в режиме полёта. Стандартные маркеры Leaflet тянут PNG из
 * пакета и ломаются при сборке — обходимся divIcon, это ещё и меньше запросов.
 */
export function createMap(container, { center = DEFAULT_CENTER, zoom = DEFAULT_ZOOM } = {}) {
  const map = L.map(container, { center, zoom, zoomControl: true });
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  // Карта часто создаётся в скрытой вкладке и не знает своих размеров.
  setTimeout(() => map.invalidateSize(), 0);
  return map;
}

export function marker(position, { priority = 'routine', source = 'gnss', title = '' } = {}) {
  const manual = source !== 'gnss';
  const icon = L.divIcon({
    className: 'pin-wrap',
    html: `<span class="pin pin-${priority} ${manual ? 'pin-manual' : ''}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  return L.marker([position.lat, position.lon], { icon, title });
}

/**
 * Прогрев кэша тайлов на текущий вид.
 *
 * Перед выходом в поле район скачивается заранее, дальше карта живёт из кэша.
 * Держим глубину маленькой: это демо-инструмент, а не полноценная выгрузка
 * региона, и заваливать чужой тайл-сервер запросами незачем.
 */
export async function warmTileCache(map, { extraZoom = 2 } = {}) {
  const urls = [];
  for (let z = map.getZoom(); z <= Math.min(map.getZoom() + extraZoom, 19); z += 1) {
    const bounds = map.getBounds();
    const min = map.project(bounds.getNorthWest(), z).divideBy(256).floor();
    const max = map.project(bounds.getSouthEast(), z).divideBy(256).floor();
    for (let x = min.x; x <= max.x; x += 1) {
      for (let y = min.y; y <= max.y; y += 1) {
        urls.push(TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
  }

  let loaded = 0;
  // По одному запросу за раз: узкий канал в поле и вежливость к тайл-серверу.
  for (const url of urls) {
    try {
      await fetch(url, { mode: 'no-cors' });
      loaded += 1;
    } catch {
      break;
    }
  }
  return { requested: urls.length, loaded };
}

export { L };

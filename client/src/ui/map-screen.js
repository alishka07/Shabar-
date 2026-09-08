import { REPORT_TYPES } from '../config.js';
import { db, listReports, notifyDataChange } from '../db.js';
import { hasCoordinates, positionFromMap } from '../geo.js';
import { createMap, marker, warmTileCache } from './map-common.js';

const TYPE_LABELS = Object.fromEntries(REPORT_TYPES.map((type) => [type.value, type.label]));

let map = null;
/** Донесение, которому сейчас проставляют координаты пальцем. */
let pinningReportId = null;

export async function renderMap(root) {
  const reports = await listReports();
  const withoutPosition = reports.filter((report) => !hasCoordinates(report.position));

  root.innerHTML = `
    <section class="card map-card">
      <div class="map-holder" id="map-holder"></div>
      <div class="map-tools">
        <button class="ghost" id="btn-warm">Скачать район в кэш</button>
        <span class="hint" id="warm-state"></span>
      </div>
      ${
        withoutPosition.length
          ? `<div class="warn">
               Без координат: ${withoutPosition.length}.
               Выберите донесение и коснитесь карты.
               <select id="pin-select">
                 <option value="">— выбрать донесение —</option>
                 ${withoutPosition
                   .map(
                     (report) =>
                       `<option value="${report.id}">№${report.number ?? '—'} · ${
                         TYPE_LABELS[report.type] || report.type
                       }</option>`,
                   )
                   .join('')}
               </select>
             </div>`
          : ''
      }
    </section>
  `;

  // Экран перерисовывается целиком при каждом изменении данных, старую карту
  // нужно снять с прежнего узла, иначе Leaflet держит обработчики мёртвого DOM.
  map?.remove();
  map = createMap(root.querySelector('#map-holder'));

  drawMarkers(reports);

  const pinSelect = root.querySelector('#pin-select');
  pinSelect?.addEventListener('change', (event) => {
    pinningReportId = event.target.value || null;
  });

  map.on('click', async (event) => {
    if (!pinningReportId) return;
    // Точка, поставленная руками, помечается источником `map` — на панели
    // управления видно, что координаты не со спутника.
    await db.reports.update(pinningReportId, {
      position: positionFromMap(event.latlng.lat, event.latlng.lng),
    });
    pinningReportId = null;
    notifyDataChange();
  });

  root.querySelector('#btn-warm').addEventListener('click', async (event) => {
    const state = root.querySelector('#warm-state');
    event.target.disabled = true;
    state.textContent = 'качаем тайлы…';
    const { requested, loaded } = await warmTileCache(map);
    state.textContent = `в кэше ${loaded} из ${requested}`;
    event.target.disabled = false;
  });
}

function drawMarkers(reports) {
  const points = reports.filter((report) => hasCoordinates(report.position));
  for (const report of points) {
    marker(report.position, {
      priority: report.priority,
      source: report.position.source,
      title: `№${report.number ?? ''} ${TYPE_LABELS[report.type] || report.type}`,
    })
      .addTo(map)
      .bindPopup(
        `<b>№${report.number ?? '—'}</b><br>${TYPE_LABELS[report.type] || report.type}<br>` +
          `источник координат: ${report.position.source}`,
      );
  }

  if (points.length) {
    const bounds = points.map((report) => [report.position.lat, report.position.lon]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}

import './styles.css';

import { attachmentContentUrl, fetchReports } from './api.js';
import { POSITION_SOURCE_LABELS, REPORT_TYPES } from './config.js';
import { enableOfflineStart } from './offline.js';
import { escapeHtml } from './ui/html.js';
import { createMap, marker } from './ui/map-common.js';

/**
 * Панель пункта управления.
 *
 * Красота не нужна. Нужно, чтобы на демо было видно, как записи появляются:
 * новая строка подсвечивается, срочное сверху, координаты, поставленные
 * вручную, помечены отдельно.
 */

const POLL_MS = 3_000;
const TYPE_LABELS = Object.fromEntries(REPORT_TYPES.map((type) => [type.value, type.label]));

const rowsBody = document.querySelector('#rows');
const totalBadge = document.querySelector('#total');
const connBadge = document.querySelector('#conn');
const typeFilter = document.querySelector('#filter-type');
const priorityFilter = document.querySelector('#filter-priority');

typeFilter.insertAdjacentHTML(
  'beforeend',
  REPORT_TYPES.map((type) => `<option value="${type.value}">${type.label}</option>`).join(''),
);

const known = new Map();
const freshIds = new Set();
let map = null;
const markers = new Map();

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function positionCell(report) {
  const { lat, lon, source } = report.position || {};
  if (lat == null || lon == null) {
    return '<span class="manual-flag">нет координат</span>';
  }
  const label = POSITION_SOURCE_LABELS[source] || source;
  const flag =
    source && source !== 'gnss' ? `<div class="manual-flag">${escapeHtml(label)}</div>` : '';
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}${flag}`;
}

function thumbs(report) {
  const photos = report.attachments.filter((item) => item.kind === 'photo' && item.complete);
  const audio = report.attachments.filter((item) => item.kind === 'audio');
  const images = photos
    .map((item) => `<img src="${attachmentContentUrl(item.id)}" alt="фото донесения" />`)
    .join('');
  const transcripts = audio.map(transcriptBlock).join('');
  return `${images ? `<div class="thumbs">${images}</div>` : ''}${transcripts}`;
}

const TRANSCRIPT_HINTS = {
  pending: 'аудио принято, ожидает распознавания',
  running: 'распознаётся…',
  disabled: 'распознавание на сервере выключено',
  failed: 'распознать не удалось',
};

/**
 * Расшифровка рядом с исходным аудио, а не вместо него.
 *
 * По-казахски и на смешанной речи открытые модели ошибаются, поэтому текст
 * здесь — черновик для оператора. Слушать оригинал он должен иметь возможность
 * всегда, каким бы уверенным ни выглядел текст.
 */
function transcriptBlock(item) {
  // Пока вложение не доехало целиком, играть нечего: байты ещё догружаются.
  const player = item.complete
    ? `<audio controls preload="none" src="${attachmentContentUrl(item.id)}"></audio>`
    : '<div class="hint">аудио догружается</div>';

  if (item.transcript_status === 'done' && item.transcript) {
    return `${player}<div class="transcript">${escapeHtml(item.transcript)}</div>`;
  }
  if (item.transcript_status === 'done') {
    return `${player}<div class="hint">речь не распознана</div>`;
  }
  const hint = TRANSCRIPT_HINTS[item.transcript_status] || 'аудио принято';
  const detail = item.transcript ? `: ${escapeHtml(item.transcript)}` : '';
  return `${player}<div class="hint">${hint}${detail}</div>`;
}

function renderRows() {
  // Срочные вперёд, внутри приоритета — самые свежие по приёму сверху.
  const reports = [...known.values()].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
    return b.received_at_server.localeCompare(a.received_at_server);
  });

  totalBadge.textContent = String(reports.length);
  rowsBody.innerHTML = reports
    .map(
      (report, index) => `
      <tr class="${report.priority === 'urgent' ? 'is-urgent' : ''} ${
        freshIds.has(report.id) ? 'is-new' : ''
      }">
        <td>${index + 1}</td>
        <td>
          <b>${escapeHtml(TYPE_LABELS[report.type] || report.type)}</b>
          ${report.priority === 'urgent' ? '<span class="urgent">срочное</span>' : ''}
          <div>${escapeHtml(report.description)}</div>
          <div class="hint">${escapeHtml(report.author || report.device_id)}</div>
          ${thumbs(report)}
        </td>
        <td>${formatTime(report.created_at_device)}</td>
        <td>${formatTime(report.received_at_server)}</td>
        <td>${positionCell(report)}</td>
      </tr>`,
    )
    .join('');
}

function renderMarkers() {
  for (const report of known.values()) {
    if (markers.has(report.id)) continue;
    const { lat, lon, source } = report.position || {};
    if (lat == null || lon == null) continue;
    const pin = marker(report.position, {
      priority: report.priority,
      source,
      title: TYPE_LABELS[report.type] || report.type,
    })
      .addTo(map)
      .bindPopup(
        `<b>${escapeHtml(TYPE_LABELS[report.type] || report.type)}</b><br>` +
          `${escapeHtml(report.description)}<br>` +
          `координаты: ${escapeHtml(POSITION_SOURCE_LABELS[source] || source)}`,
      );
    markers.set(report.id, pin);
  }
}

async function poll() {
  try {
    const reports = await fetchReports({
      type: typeFilter.value || undefined,
      priority: priorityFilter.value || undefined,
    });
    connBadge.textContent = 'сервер отвечает';
    connBadge.className = 'conn is-online';

    freshIds.clear();
    const seen = new Set();
    for (const report of reports) {
      if (!known.has(report.id)) freshIds.add(report.id);
      known.set(report.id, report);
      seen.add(report.id);
    }
    // Фильтры сузили выборку — показываем ровно то, что вернул сервер.
    for (const id of [...known.keys()]) {
      if (!seen.has(id)) {
        known.delete(id);
        markers.get(id)?.remove();
        markers.delete(id);
      }
    }

    renderRows();
    renderMarkers();
  } catch (error) {
    connBadge.textContent = 'сервер не отвечает';
    connBadge.className = 'conn is-offline';
  }
}

enableOfflineStart();
map = createMap(document.querySelector('#map'));
typeFilter.addEventListener('change', poll);
priorityFilter.addEventListener('change', poll);

poll();
setInterval(poll, POLL_MS);

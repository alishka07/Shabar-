import { POSITION_SOURCE_LABELS, REPORT_TYPES } from '../config.js';
import { listReports } from '../db.js';
import { formatPosition } from '../geo.js';
import { escapeHtml } from './html.js';

const TYPE_LABELS = Object.fromEntries(REPORT_TYPES.map((type) => [type.value, type.label]));

const STATE_LABELS = {
  draft: 'черновик',
  queued: 'в очереди',
  sending: 'отправляется',
  sent: 'отправлено',
  error: 'ошибка',
};

/** Координаты и то, откуда они взялись. Без координат — одна честная строка. */
function positionLine(position) {
  if (!position || position.lat == null || position.lon == null) return 'нет координат';
  const source = POSITION_SOURCE_LABELS[position.source] || position.source;
  return `${formatPosition(position)} · ${source}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function renderList(root) {
  const reports = await listReports();

  if (!reports.length) {
    root.innerHTML = '<section class="card"><p class="empty">Донесений пока нет</p></section>';
    return;
  }

  root.innerHTML = `
    <section class="card">
      <h2>Донесения <span class="count">${reports.length}</span></h2>
      <ul class="reports">
        ${reports
          .map(
            (report) => `
          <li class="report ${report.priority === 'urgent' ? 'is-urgent' : ''}">
            <div class="report-head">
              <span class="report-number">№${report.number ?? '—'}</span>
              <span class="report-type">${TYPE_LABELS[report.type] || report.type}</span>
              <span class="badge badge-${report.sync_state}">${STATE_LABELS[report.sync_state]}</span>
            </div>
            <p class="report-text">${escapeHtml(report.description) || '<i>без описания</i>'}</p>
            <div class="report-meta">
              ${[
                formatTime(report.created_at_device),
                positionLine(report.position),
                report.attachments.length ? `вложений ${report.attachments.length}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </li>`,
          )
          .join('')}
      </ul>
    </section>
  `;
}

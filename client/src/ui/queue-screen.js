import { listReports } from '../db.js';
import { formatBytes } from '../media.js';
import { getStatus, sync } from '../sync.js';

/**
 * Экран очереди. Центр демонстрации.
 *
 * Он должен отвечать на один вопрос без объяснений вслух: что сейчас
 * происходит с каждой записью и почему она ещё не ушла.
 */

const STATE_LABELS = {
  draft: 'Черновик',
  queued: 'В очереди',
  sending: 'Отправляется',
  sent: 'Отправлено',
  error: 'Ошибка',
};

function attachmentProgress(attachments) {
  if (!attachments.length) return '';
  const parts = [];

  const photos = attachments.filter((item) => item.kind === 'photo');
  if (photos.length) {
    const done = photos.filter((item) => item.state === 'done').length;
    let line = `фото ${done} из ${photos.length}`;

    // Начатое вложение показываем в байтах. Именно эта строка отвечает на
    // вопрос «а если связь оборвётся посреди файла»: после обрыва число не
    // обнуляется, догрузка продолжится с него.
    const partial = photos.find((item) => item.state !== 'done' && item.uploaded_bytes > 0);
    if (partial) {
      line += ` · текущее ${formatBytes(partial.uploaded_bytes)} из ${formatBytes(partial.bytes)}`;
      if (partial.state === 'error') line += ', обрыв';
    }
    parts.push(line);
  }

  const audio = attachments.find((item) => item.kind === 'audio');
  if (audio) {
    parts.push(audio.state === 'done' ? 'аудио доставлено' : 'аудио в очереди');
  }
  return parts.join(' · ');
}

export async function renderQueue(root) {
  const reports = await listReports();
  const { online, running } = getStatus();

  // Порядок на экране — тот же, в каком записи будут уходить.
  const pending = reports
    .filter((report) => report.sync_state !== 'sent')
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
      return a.created_at_device.localeCompare(b.created_at_device);
    });
  // Уже ушедшие показываем в том порядке, в каком они уходили.
  const sent = reports
    .filter((report) => report.sync_state === 'sent')
    .sort((a, b) => a.created_at_device.localeCompare(b.created_at_device));

  const row = (report) => {
    const progress = attachmentProgress(report.attachments);
    const error = report.sync_state === 'error' && report.last_error
      ? `<div class="queue-error">${report.last_error}</div>`
      : '';
    return `
      <li class="queue-row state-${report.sync_state}">
        <span class="queue-state">${STATE_LABELS[report.sync_state] || report.sync_state}</span>
        <span class="queue-name">
          Донесение №${report.number ?? '—'}
          ${report.priority === 'urgent' ? '<b class="urgent">срочное</b>' : ''}
        </span>
        <span class="queue-progress">${progress}</span>
        ${error}
      </li>`;
  };

  root.innerHTML = `
    <section class="card">
      <h2>Синхронизация</h2>
      <ul class="queue">
        ${[...sent, ...pending].map(row).join('') || '<li class="empty">Очередь пуста</li>'}
      </ul>
      <div class="conn-line ${online ? 'is-online' : 'is-offline'}">
        Соединение: <b>${online ? 'ЕСТЬ' : 'НЕТ'}</b>${running ? ' · идёт обмен' : ''}
      </div>
      <button class="ghost" id="btn-sync-now">Проверить канал сейчас</button>
      <p class="hint">
        Отправка запускается сама при появлении сети. Кнопка нужна только для показа.
      </p>
    </section>
  `;

  root.querySelector('#btn-sync-now').addEventListener('click', () => sync());
}

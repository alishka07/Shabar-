import * as api from './api.js';
import { BACKOFF_MS, BATCH_SIZE, CHUNK_BYTES, SCHEMA_VERSION, SYNC_INTERVAL_MS } from './config.js';
import { db, getAttachmentBlob, getReport, notifyDataChange } from './db.js';
import { isUnlocked } from './vault.js';

/**
 * Ядро проекта.
 *
 * Правила, которые здесь соблюдаются и которые стоит держать в голове при
 * любой правке:
 *
 *  - UUID донесения рождается на клиенте в момент создания, задолго до отправки.
 *    Поэтому повтор после обрыва — это тот же самый id, и сервер его отбрасывает.
 *  - Ответ `duplicate` — успех. Запись помечается отправленной.
 *  - Первым уходит компактный JSON с текстом и координатами. Фото и аудио
 *    догружаются потом, кусками, с продолжением с места обрыва.
 *  - Порядок: сначала срочные, внутри приоритета — по времени создания.
 *  - Повторы с нарастающей задержкой, без цикла, сажающего батарею.
 *  - Пользователь ничего не нажимает.
 */

let running = false;
let online = false;
const statusListeners = new Set();

export function onSyncStatus(listener) {
  statusListeners.add(listener);
  listener(getStatus());
  return () => statusListeners.delete(listener);
}

export function getStatus() {
  return { online, running };
}

function emitStatus() {
  const status = getStatus();
  for (const listener of statusListeners) listener(status);
}

/** Срочные вперёд, внутри приоритета — по времени создания. */
function compareForSend(a, b) {
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  return a.created_at_device.localeCompare(b.created_at_device);
}

function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Донесение в том виде, в каком его ждёт сервер.
 *
 * Здесь запись впервые за всё время расшифровывается: в базе она лежит
 * запечатанной, ключ живёт только в памяти вкладки.
 */
async function toWire(reportId) {
  const report = await getReport(reportId);
  const attachments = await db.attachments.where('report_id').equals(report.id).toArray();
  return {
    id: report.id,
    schema_version: SCHEMA_VERSION,
    device_id: report.device_id,
    author: report.author,
    type: report.type,
    priority: report.priority,
    description: report.description,
    quantity: report.quantity,
    created_at_device: report.created_at_device,
    position: report.position,
    // Байты вложений сюда не попадают — только объявление о намерении догрузить.
    // sync_state живёт только на клиенте и на сервер не отправляется.
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      bytes: attachment.bytes,
      content_type: attachment.content_type,
    })),
  };
}

async function markSent(reportId) {
  await db.transaction('rw', db.reports, db.outbox, async () => {
    await db.reports.update(reportId, { sync_state: 'sent', sent_at: new Date().toISOString() });
    await db.outbox.delete(reportId);
  });
}

async function markFailed(reportId, error, { permanent = false } = {}) {
  const task = await db.outbox.get(reportId);
  const attempts = (task?.attempts ?? 0) + 1;
  await db.transaction('rw', db.reports, db.outbox, async () => {
    await db.reports.update(reportId, { sync_state: 'error', last_error: error });
    await db.outbox.update(reportId, {
      state: permanent ? 'rejected' : 'error',
      attempts,
      last_error: error,
      // Отвергнутое по схеме донесение не имеет смысла слать снова тем же кодом:
      // ждём заметно дольше, чтобы не молотить сеть впустую.
      next_attempt_at: Date.now() + (permanent ? BACKOFF_MS.at(-1) : backoffFor(attempts)),
    });
  });
}

async function sendReports() {
  const now = Date.now();
  const tasks = await db.outbox.toArray();
  const due = tasks.filter((task) => (task.next_attempt_at ?? 0) <= now);
  if (!due.length) return;

  // Приоритет и время создания лежат в базе открытыми, поэтому очередь
  // выстраивается без единой операции расшифровки.
  const rows = (await db.reports.bulkGet(due.map((task) => task.report_id)))
    .filter(Boolean)
    .sort(compareForSend);

  for (const batch of batches(rows, BATCH_SIZE)) {
    const ids = batch.map((row) => row.id);
    await db.reports.where('id').anyOf(ids).modify({ sync_state: 'sending' });
    notifyDataChange();

    let results;
    try {
      results = await api.postReports(await Promise.all(ids.map(toWire)));
    } catch (error) {
      // Связь оборвалась. Мы не знаем, дошла пачка или нет, и это неважно:
      // повтор с теми же id безопасен.
      for (const id of ids) await markFailed(id, String(error));
      notifyDataChange();
      return;
    }

    const byId = new Map(results.map((result) => [result.id, result]));
    for (const id of ids) {
      const result = byId.get(id);
      if (!result) {
        await markFailed(id, 'сервер не ответил по этому донесению');
      } else if (result.result === 'accepted' || result.result === 'duplicate') {
        await markSent(id);
      } else {
        await markFailed(id, result.reason || 'rejected', { permanent: true });
      }
    }
    notifyDataChange();
  }
}

/**
 * Догрузка одного вложения.
 *
 * Смещение берём у сервера, а не из своей памяти: после обрыва он — источник
 * правды о том, сколько дошло.
 */
async function uploadAttachment(attachment) {
  const state = await api.attachmentState(attachment.id);
  let offset = state.received_bytes;

  if (state.complete) {
    await db.attachments.update(attachment.id, { state: 'done', uploaded_bytes: attachment.bytes });
    return;
  }

  await db.attachments.update(attachment.id, { state: 'uploading', uploaded_bytes: offset });
  notifyDataChange();

  // Расшифровываем один раз на вложение и режем на куски уже открытые байты.
  const blob = await getAttachmentBlob(attachment.id);
  if (!blob) throw new Error('вложение потеряно в локальной базе');

  while (offset < attachment.bytes) {
    const slice = blob.slice(offset, offset + CHUNK_BYTES);
    const response = await api.postChunk(attachment.id, offset, slice);

    if (response.received_bytes === offset && slice.size > 0) {
      throw new Error('сервер не принял кусок, смещение не сдвинулось');
    }
    offset = response.received_bytes;
    await db.attachments.update(attachment.id, { uploaded_bytes: offset });
    notifyDataChange();

    if (response.complete) break;
  }

  await db.attachments.update(attachment.id, { state: 'done', uploaded_bytes: offset });
  notifyDataChange();
}

async function uploadAttachments() {
  // Вложение имеет смысл грузить только после того, как принято само донесение.
  const sent = await db.reports.where('sync_state').equals('sent').toArray();
  if (!sent.length) return;

  const priorityById = new Map(sent.map((report) => [report.id, report.priority]));
  const pending = (await db.attachments.where('report_id').anyOf([...priorityById.keys()]).toArray())
    .filter((attachment) => attachment.state !== 'done')
    .sort((a, b) => {
      const pa = priorityById.get(a.report_id);
      const pb = priorityById.get(b.report_id);
      if (pa !== pb) return pa === 'urgent' ? -1 : 1;
      // Фото раньше аудио: аудио разбирается на сервере и терпит.
      if (a.kind !== b.kind) return a.kind === 'photo' ? -1 : 1;
      return 0;
    });

  for (const attachment of pending) {
    try {
      await uploadAttachment(attachment);
    } catch (error) {
      await db.attachments.update(attachment.id, { state: 'error', last_error: String(error) });
      notifyDataChange();
      // Канал пропал посреди файла. Уже принятые байты сервер помнит,
      // следующий заход продолжит с них.
      return;
    }
  }
}

/** Один проход очереди. Повторный вызов во время работы ничего не делает. */
export async function sync() {
  if (running) return;
  // Пока ПИН-код не введён, ключа нет, а без него донесение не расшифровать и
  // не отправить. Молча ждём, ничего не ломая: записи лежат в очереди.
  if (!isUnlocked()) return;

  running = true;
  emitStatus();
  try {
    online = await api.probe();
    if (!online) return;
    await sendReports();
    await uploadAttachments();
  } finally {
    running = false;
    emitStatus();
    notifyDataChange();
  }
}

/**
 * Автозапуск. Пользователь ничего не нажимает: синхронизация стартует сама
 * при появлении сети, при возврате в приложение и по таймеру.
 */
export function startSyncLoop() {
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => {
    online = false;
    emitStatus();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
  setInterval(() => sync(), SYNC_INTERVAL_MS);
  sync();
}

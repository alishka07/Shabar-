import Dexie from 'dexie';

import { decryptBytes, decryptText, encryptBytes, encryptText } from './crypto.js';
import { requireKey } from './vault.js';

/**
 * Локальная база. Всё пишется сюда до любой попытки отправки — это и есть
 * условие того, что приложение полностью работает в режиме полёта, включая
 * первый запуск после установки.
 *
 * Фото и аудио лежат здесь же, как Blob. Не в оперативной памяти: убийство
 * вкладки посреди работы не должно стоить ни одной записи.
 *
 * Содержимое зашифровано ключом из ПИН-кода оператора (см. vault.js).
 * Открытыми остаются только поля, по которым Dexie строит индексы и работает
 * очередь: `id`, `priority`, `created_at_device`, `sync_state`. Что это значит
 * на потерянном устройстве: видно, что донесений было столько-то, столько-то
 * из них срочные и созданы тогда-то. Не видно ни типа, ни описания, ни
 * координат, ни единого байта фото и аудио. Метаданные мы намеренно не прячем,
 * иначе очередь пришлось бы расшифровывать целиком на каждый чих.
 */
export const db = new Dexie('khabar');

db.version(1).stores({
  // sync_state: draft | queued | sending | sent | error
  reports: 'id, sync_state, priority, created_at_device',
  // state: queued | uploading | done | error
  attachments: 'id, report_id, state',
  // Одна задача на донесение: ключ — report_id, повторов быть не может.
  outbox: 'report_id, state, next_attempt_at',
});

/** Поля донесения, которые остаются открытыми. Всё прочее уходит в `sealed`. */
const OPEN_REPORT_FIELDS = ['id', 'priority', 'created_at_device', 'sync_state', 'sent_at'];

/**
 * Поля вложения, которые остаются открытыми.
 *
 * `bytes` — длина исходного файла, а не шифротекста: по ней клиент считает
 * прогресс и объявляет размер серверу. `content_type` открыт по той же причине.
 */
const OPEN_ATTACHMENT_FIELDS = [
  'id',
  'report_id',
  'kind',
  'state',
  'bytes',
  'content_type',
  'uploaded_bytes',
];

/** Подписка на любые изменения данных, чтобы экраны перерисовывались сами. */
const listeners = new Set();

export function onDataChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyDataChange() {
  for (const listener of listeners) listener();
}

function split(source, openFields) {
  const open = {};
  const secret = {};
  for (const [name, value] of Object.entries(source)) {
    if (openFields.includes(name)) open[name] = value;
    else secret[name] = value;
  }
  return { open, secret };
}

async function sealReport(report) {
  const { open, secret } = split(report, OPEN_REPORT_FIELDS);
  return { ...open, sealed: await encryptText(requireKey(), JSON.stringify(secret)) };
}

async function openReport(row) {
  if (!row) return row;
  // Записи, созданные до включения шифрования, читаются как есть: при первом
  // вводе ПИН-кода их перезапишет resealPlaintextRows().
  if (!row.sealed) return row;
  const { sealed, ...open } = row;
  return { ...open, ...JSON.parse(await decryptText(requireKey(), sealed)) };
}

async function sealAttachment(attachment) {
  const { open, secret } = split(attachment, OPEN_ATTACHMENT_FIELDS);
  const { blob, ...rest } = secret;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    ...open,
    sealed: await encryptText(requireKey(), JSON.stringify(rest)),
    sealed_blob: await encryptBytes(requireKey(), bytes),
  };
}

/**
 * Метаданные вложения без самих байтов.
 *
 * Списку и экрану очереди содержимое фото не нужно, а расшифровывать по
 * четверти мегабайта на каждую перерисовку — верный способ подвесить телефон.
 */
function openAttachmentMeta(row) {
  const { sealed, sealed_blob: sealedBlob, blob, ...open } = row;
  return open;
}

/** Байты вложения. Нужны ровно в одном месте — при догрузке в sync.js. */
export async function getAttachmentBlob(attachmentId) {
  const row = await db.attachments.get(attachmentId);
  if (!row) return null;
  if (!row.sealed_blob) return row.blob ?? null;
  const bytes = await decryptBytes(requireKey(), row.sealed_blob);
  return new Blob([bytes], { type: row.content_type || 'application/octet-stream' });
}

export async function saveReport(report, attachments = []) {
  // Шифруем до транзакции: WebCrypto асинхронный, а транзакция Dexie не
  // переживает ожидания на чужих промисах.
  const sealedReport = await sealReport(report);
  const sealedAttachments = await Promise.all(attachments.map(sealAttachment));

  await db.transaction('rw', db.reports, db.attachments, db.outbox, async () => {
    await db.reports.put(sealedReport);
    if (sealedAttachments.length) await db.attachments.bulkPut(sealedAttachments);
    if (report.sync_state === 'queued') {
      await db.outbox.put({
        report_id: report.id,
        state: 'queued',
        attempts: 0,
        next_attempt_at: 0,
        last_error: null,
      });
    }
  });
  notifyDataChange();
}

/** Одно донесение в открытом виде. Используется очередью перед отправкой. */
export async function getReport(reportId) {
  return openReport(await db.reports.get(reportId));
}

export async function listReports() {
  const rows = await db.reports.orderBy('created_at_device').reverse().toArray();
  const reports = await Promise.all(rows.map(openReport));

  const byReport = new Map();
  for (const row of await db.attachments.toArray()) {
    if (!byReport.has(row.report_id)) byReport.set(row.report_id, []);
    byReport.get(row.report_id).push(openAttachmentMeta(row));
  }

  return reports.map((report) => ({
    ...report,
    attachments: byReport.get(report.id) || [],
  }));
}

/**
 * Дошифровка записей, созданных прошлой версией приложения.
 *
 * Вызывается один раз сразу после ввода ПИН-кода. Без неё на устройстве,
 * пережившем обновление, часть донесений так и осталась бы открытым текстом —
 * ровно то, от чего мы защищаемся.
 */
export async function resealPlaintextRows() {
  let resealed = 0;

  for (const row of await db.reports.toArray()) {
    if (row.sealed) continue;
    await db.reports.put(await sealReport(row));
    resealed += 1;
  }

  for (const row of await db.attachments.toArray()) {
    if (row.sealed_blob) continue;
    await db.attachments.put(await sealAttachment(row));
    resealed += 1;
  }

  if (resealed) notifyDataChange();
  return resealed;
}

/**
 * Быстрое стирание. Устройство может быть потеряно, и это должно занимать
 * одно нажатие, а не поход в настройки браузера.
 */
export async function wipeLocalData() {
  await db.delete();
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  }
  // Вместе с настройками уходят соль и контрольное значение ПИН-кода.
  localStorage.clear();
}

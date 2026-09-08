import Dexie from 'dexie';

/**
 * Локальная база. Всё пишется сюда до любой попытки отправки — это и есть
 * условие того, что приложение полностью работает в режиме полёта, включая
 * первый запуск после установки.
 *
 * Фото и аудио лежат здесь же, как Blob. Не в оперативной памяти: убийство
 * вкладки посреди работы не должно стоить ни одной записи.
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

/** Подписка на любые изменения данных, чтобы экраны перерисовывались сами. */
const listeners = new Set();

export function onDataChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyDataChange() {
  for (const listener of listeners) listener();
}

export async function saveReport(report, attachments = []) {
  await db.transaction('rw', db.reports, db.attachments, db.outbox, async () => {
    await db.reports.put(report);
    if (attachments.length) await db.attachments.bulkPut(attachments);
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

export async function listReports() {
  const reports = await db.reports.orderBy('created_at_device').reverse().toArray();
  const attachments = await db.attachments.toArray();
  const byReport = new Map();
  for (const attachment of attachments) {
    if (!byReport.has(attachment.report_id)) byReport.set(attachment.report_id, []);
    byReport.get(attachment.report_id).push(attachment);
  }
  return reports.map((report) => ({
    ...report,
    attachments: byReport.get(report.id) || [],
  }));
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
  localStorage.clear();
}

export const SCHEMA_VERSION = 1;

/** Справочник типов донесений зашит в приложение: в поле его неоткуда взять. */
export const REPORT_TYPES = [
  { value: 'detection', label: 'Обнаружение', quantityLabel: 'Количество единиц' },
  { value: 'unit_status', label: 'Состояние подразделения', quantityLabel: 'Личный состав' },
  { value: 'equipment_fault', label: 'Неисправность техники', quantityLabel: 'Номер машины' },
  { value: 'supply_request', label: 'Запрос обеспечения', quantityLabel: 'Количество' },
  { value: 'incident', label: 'Происшествие', quantityLabel: 'Пострадавших' },
];

export const PRIORITIES = [
  { value: 'routine', label: 'Обычный' },
  { value: 'urgent', label: 'Срочный' },
];

export const POSITION_SOURCE_LABELS = {
  gnss: 'спутник',
  manual: 'вручную',
  map: 'точка на карте',
  none: 'нет координат',
};

/** Кусок вложения. Мелко, чтобы обрыв стоил не больше одного куска. */
export const CHUNK_BYTES = 64 * 1024;

/** Сколько донесений уходит одним запросом. */
export const BATCH_SIZE = 10;

/**
 * Нарастающая задержка между попытками. Последнее значение повторяется, цикл
 * не бесконечный по частоте — иначе разряжаем батарею в поле.
 */
export const BACKOFF_MS = [0, 5_000, 15_000, 60_000, 300_000, 900_000];

/** Как часто будим очередь сами, если не было события online. */
export const SYNC_INTERVAL_MS = 10_000;

/** Сколько ждём ответа пробы канала, прежде чем считать его мёртвым. */
export const PROBE_TIMEOUT_MS = 4_000;

/** Сжатие фото при добавлении: узкий канал важнее мегапикселей. */
export const PHOTO_MAX_EDGE_PX = 1280;
export const PHOTO_JPEG_QUALITY = 0.7;

/** Тайлы карты. На демо регион прогревается заранее, см. docs/demo.md. */
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '© OpenStreetMap';
export const DEFAULT_CENTER = [51.1605, 71.4704];
export const DEFAULT_ZOOM = 12;

const DEVICE_ID_KEY = 'khabar.device_id';
const AUTHOR_KEY = 'khabar.author';
const COUNTER_KEY = 'khabar.report_counter';

/** Идентификатор устройства переживает перезапуск и попадает в каждое донесение. */
export function deviceId() {
  let value = localStorage.getItem(DEVICE_ID_KEY);
  if (!value) {
    value = `dev-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(DEVICE_ID_KEY, value);
  }
  return value;
}

export function author() {
  return localStorage.getItem(AUTHOR_KEY) || '';
}

export function setAuthor(value) {
  localStorage.setItem(AUTHOR_KEY, value);
}

/**
 * Короткий номер донесения для человека. Идентификатор записи — UUID, но
 * произносить его вслух в поле и на разборе невозможно, поэтому у каждой
 * записи есть ещё и номер по порядку.
 */
export function nextReportNumber() {
  const next = Number(localStorage.getItem(COUNTER_KEY) || '100') + 1;
  localStorage.setItem(COUNTER_KEY, String(next));
  return next;
}

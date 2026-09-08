import { PROBE_TIMEOUT_MS } from './config.js';

const BASE = '/api/v1';

async function request(path, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проба канала. navigator.onLine говорит лишь о наличии интерфейса: Wi-Fi
 * без выхода наружу он считает сетью. Спрашиваем сервер напрямую.
 */
export async function probe() {
  if (!navigator.onLine) return false;
  try {
    const response = await request('/health', { cache: 'no-store' }, PROBE_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

/** Отправка пачки донесений. Возвращает результат по каждому id. */
export async function postReports(payload) {
  const response = await request('/sync/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`sync/reports ${response.status}`);
  return response.json();
}

/** Сколько байт вложения сервер уже принял. Точка продолжения после обрыва. */
export async function attachmentState(attachmentId) {
  const response = await request(`/sync/attachments/${attachmentId}/chunk`);
  if (!response.ok) throw new Error(`attachment state ${response.status}`);
  return response.json();
}

/**
 * Один кусок вложения. Ответ 409 (сервер принял меньше, чем мы думали) — не
 * ошибка, а поправка: в теле лежит настоящее смещение, с него и продолжаем.
 */
export async function postChunk(attachmentId, offset, blob) {
  const response = await request(
    `/sync/attachments/${attachmentId}/chunk?offset=${offset}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    },
  );
  if (!response.ok && response.status !== 409) {
    throw new Error(`chunk ${response.status}`);
  }
  return response.json();
}

/** Чтение для панели пункта управления. */
export async function fetchReports({ since, type, priority } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (type) params.set('type', type);
  if (priority) params.set('priority', priority);
  const query = params.toString();
  const response = await request(`/reports${query ? `?${query}` : ''}`);
  if (!response.ok) throw new Error(`reports ${response.status}`);
  return response.json();
}

export function attachmentContentUrl(attachmentId) {
  return `${BASE}/attachments/${attachmentId}/content`;
}

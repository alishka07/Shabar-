import { PHOTO_JPEG_QUALITY, PHOTO_MAX_EDGE_PX } from './config.js';

/**
 * Фото сжимается сразу при добавлении, а не перед отправкой.
 *
 * Причина не в месте на диске. Канал появляется на двадцать секунд, и в эти
 * двадцать секунд должно поместиться как можно больше. Снимок с телефона на
 * четыре мегабайта в такое окно не помещается, сжатый на двести килобайт —
 * помещается.
 */
export async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY),
  );
  return blob ?? file;
}

export function makeAttachment({ reportId, kind, blob, contentType }) {
  return {
    id: crypto.randomUUID(),
    report_id: reportId,
    kind,
    content_type: contentType || blob.type || 'application/octet-stream',
    bytes: blob.size,
    blob,
    uploaded_bytes: 0,
    state: 'queued',
  };
}

/**
 * Запись голосового донесения. Модели распознавания на устройстве нет и не
 * будет: она весит десятки мегабайт, а качество по казахской и смешанной речи
 * низкое. Пишем аудио в локальную базу, разбор делает сервер после доставки.
 */
export function createRecorder() {
  let recorder = null;
  let chunks = [];

  return {
    async start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.start();
    },

    stop() {
      return new Promise((resolve) => {
        if (!recorder) return resolve(null);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          recorder.stream.getTracks().forEach((track) => track.stop());
          recorder = null;
          resolve(blob);
        };
        recorder.stop();
      });
    },

    get recording() {
      return recorder?.state === 'recording';
    },
  };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

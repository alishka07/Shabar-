import { PHOTO_JPEG_QUALITY, PHOTO_MAX_EDGE_PX } from './config.js';
import { createVoiceGate } from './vad.js';

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

/** Опус на низком битрейте: речь разборчива, канал не забит. */
const AUDIO_BITS_PER_SECOND = 24_000;

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

/**
 * Запись голосового донесения. Модели распознавания на устройстве нет и не
 * будет: она весит десятки мегабайт, а качество по казахской и смешанной речи
 * низкое. Пишем аудио в локальную базу, разбор делает сервер после доставки.
 *
 * Тишина в запись не попадает: гейт (см. vad.js) ставит MediaRecorder на паузу,
 * пока никто не говорит. Перекодирования при этом нет — кодек просто не
 * получает пауз, — так что экономия канала достаётся даром.
 */
export function createRecorder() {
  let recorder = null;
  let gate = null;
  let chunks = [];
  let startedAt = 0;
  let recordedMs = 0;
  let resumedAt = 0;

  function markPaused() {
    if (!resumedAt) return;
    recordedMs += performance.now() - resumedAt;
    resumedAt = 0;
  }

  return {
    /**
     * `trimSilence: false` — писать всё подряд, гейт не поднимать.
     * `prefer` передаётся гейту: 'auto' или 'loudness'.
     */
    async start({ trimSilence = true, prefer = 'auto' } = {}) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });

      chunks = [];
      recordedMs = 0;
      startedAt = performance.now();
      resumedAt = startedAt;

      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        ...(mimeType ? { mimeType } : {}),
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      // Кусками: без интервала пауза и снятие с паузы не отдают данные вовремя.
      recorder.start(250);

      if (!trimSilence) return { mode: 'off' };

      try {
        gate = await createVoiceGate(stream, {
          prefer,
          onSpeech: (speaking) => {
            if (!recorder) return;
            if (speaking && recorder.state === 'paused') {
              resumedAt = performance.now();
              recorder.resume();
            } else if (!speaking && recorder.state === 'recording') {
              markPaused();
              recorder.pause();
            }
          },
        });
        return { mode: gate.mode };
      } catch (error) {
        // Гейт — улучшение, а не условие работы. Не поднялся — пишем всё
        // подряд: потерять донесение из-за неудавшегося VAD недопустимо.
        console.warn('гейт речи не поднялся, пишем без обрезки тишины:', error);
        gate = null;
        return { mode: 'off' };
      }
    },

    stop() {
      return new Promise((resolve) => {
        if (!recorder) return resolve(null);
        recorder.onstop = async () => {
          markPaused();
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          recorder.stream.getTracks().forEach((track) => track.stop());
          const elapsedMs = performance.now() - startedAt;
          recorder = null;

          await gate?.stop();
          gate = null;

          resolve({
            blob,
            elapsedMs,
            recordedMs,
            // Сколько тишины не поехало по каналу. Число для оператора и для питча.
            trimmedMs: Math.max(0, elapsedMs - recordedMs),
          });
        };
        if (recorder.state === 'paused') recorder.resume();
        recorder.stop();
      });
    },

    get recording() {
      return recorder !== null && recorder.state !== 'inactive';
    },
  };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

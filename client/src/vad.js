/**
 * Обнаружение речи. Вырезает тишину до того, как аудио попадёт в очередь.
 *
 * Зачем. Оператор наговорил сорок секунд, из них речи двенадцать. По узкому
 * каналу мы гнали бы сорок. Здесь мы не режем готовый файл — это потребовало бы
 * перекодирования и в браузере стоило бы дороже, чем экономит, — а ставим
 * запись на паузу в тишине и снимаем с паузы на речи. Кодек продолжает писать
 * тот же поток, просто в нём нет пауз.
 *
 * Побочный эффект важнее экономии. Whisper галлюцинирует на тишине и шуме:
 * выдаёт обрывки фраз из обучающих данных там, где не было сказано ничего.
 * Меньше тишины на входе — меньше выдуманного текста на выходе.
 *
 * Основной режим — Silero VAD v5 через ONNX Runtime. Если среда или модель не
 * поднялись (первая запись случилась без связи, файлы не в кэше, старый
 * браузер), включается запасной режим по громкости. Он грубее и в шуме
 * ошибается в безопасную сторону — оставляет лишнее, а не режет речь.
 */

/** Silero v5 принимает ровно 512 отсчётов при 16 кГц. Не 480 и не 1024. */
const FRAME_SAMPLES = 512;
const SAMPLE_RATE = 16000;

/** Порог начала речи и порог её окончания разведены: иначе гейт дребезжит. */
const SPEECH_START_PROB = 0.5;
const SPEECH_STOP_PROB = 0.35;

/** Сколько ещё пишем после того, как речь кончилась. */
const HANGOVER_MS = 800;

/**
 * Первые секунды пишем всегда.
 *
 * Гейт узнаёт о начале речи с задержкой в кадр, и без этой форы первый слог
 * донесения оказался бы срезан. Лучше отдать лишнюю секунду тишины, чем слово.
 */
const LEAD_IN_MS = 1200;

/**
 * Среда выполнения подключается тегом script, а не импортом из пакета.
 *
 * Импорт заставил бы сборщик утащить в дистрибутив 27 МБ wasm с поддержкой
 * видеокарты, которая нам не нужна ни на одном телефоне. Модульную сборку из
 * public Vite в режиме разработки отдавать отказывается, поэтому берём
 * классическую: она объявляет глобальный `ort` и одинаково работает и в
 * разработке, и в собранном виде. Файлы в /ort/ раскладывает
 * scripts/copy-ort.mjs при установке зависимостей.
 */
const ORT_ENTRY = '/ort/ort.wasm.min.js';
const ORT_WASM_DIR = '/ort/';
const MODEL_URL = '/models/silero_vad.onnx';

let ortPromise = null;
let sessionPromise = null;

function loadOrtRuntime() {
  if (window.ort) return Promise.resolve(window.ort);

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ORT_ENTRY;
    script.onload = () =>
      window.ort ? resolve(window.ort) : reject(new Error('ort не объявлен после загрузки'));
    script.onerror = () => reject(new Error(`не удалось загрузить ${ORT_ENTRY}`));
    document.head.append(script);
  });
}

/**
 * Среда выполнения грузится по требованию, при первой записи.
 *
 * Она весит около 14 МБ и в холодный старт приложения ей нечего делать:
 * донесение без голоса — обычное дело, а вот лишние 14 МБ на запуске в поле —
 * нет. После первой записи всё оседает в кэше service worker.
 */
async function loadSileroSession() {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    ortPromise = ortPromise || loadOrtRuntime();
    const ort = await ortPromise;

    // Один поток: многопоточный wasm потребовал бы cross-origin isolation,
    // то есть заголовков COOP/COEP на раздаче. Нам это не окупается.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ORT_WASM_DIR;

    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
    return { ort, session };
  })().catch((error) => {
    console.warn('Silero VAD недоступен, переходим на определение по громкости:', error);
    sessionPromise = null;
    return null;
  });

  return sessionPromise;
}

/** Состояние рекуррентной сети. Переносится из кадра в кадр. */
function freshState(ort) {
  return new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
}

function createSileroDetector({ ort, session }) {
  let state = freshState(ort);
  const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

  return async (frame) => {
    const output = await session.run({
      input: new ort.Tensor('float32', frame, [1, FRAME_SAMPLES]),
      state,
      sr: sampleRate,
    });
    state = output.stateN;
    return output.output.data[0];
  };
}

/**
 * Запасной определитель: по громкости относительно пола шума.
 *
 * Пол шума оценивается снизу и медленно отпускается вверх, чтобы гейт не
 * закрылся навсегда после громкого хлопка рядом с микрофоном.
 */
function createLoudnessDetector() {
  let noiseFloor = 0.01;

  return async (frame) => {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);

    noiseFloor = rms < noiseFloor ? rms : noiseFloor * 0.999 + rms * 0.001;
    const threshold = Math.max(noiseFloor * 3, 0.012);
    return rms > threshold ? 1 : 0;
  };
}

/**
 * Ставит гейт на поток микрофона.
 *
 * `onSpeech(active)` вызывается только на смене состояния, а не на каждом кадре.
 * Возвращает объект с `mode` (silero | loudness) и `stop()`.
 *
 * `prefer: 'loudness'` заставляет взять простой определитель, не поднимая
 * модель. Нужен, когда Silero на конкретном устройстве ведёт себя странно, и
 * им же проверяется механика гейта в тестах.
 */
export async function createVoiceGate(stream, { onSpeech, prefer = 'auto' }) {
  const silero = prefer === 'loudness' ? null : await loadSileroSession();
  const detect = silero ? createSileroDetector(silero) : createLoudnessDetector();
  const mode = silero ? 'silero' : 'loudness';

  // Контекст сразу на 16 кГц: пересчёт частоты браузер делает сам, и нам не
  // нужно ни своего ресемплера, ни отдельного прохода по буферу.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);

  // ScriptProcessorNode помечен устаревшим, но поддерживается везде и сегодня.
  // Замена — AudioWorklet, однако вывод модели всё равно считается в основном
  // потоке, так что переезд дал бы только лишний файл воркета.
  const processor = context.createScriptProcessor(2048, 1, 1);

  const startedAt = performance.now();
  let speaking = false;
  let lastSpeechAt = 0;
  let busy = false;
  let pending = [];
  let stopped = false;

  const carry = new Float32Array(FRAME_SAMPLES);
  let carried = 0;

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (pending.length) {
        const frame = pending.shift();
        const probability = await detect(frame);
        if (stopped) return;
        applyProbability(probability);
      }
    } finally {
      busy = false;
    }
  }

  function applyProbability(probability) {
    const now = performance.now();

    if (probability >= SPEECH_START_PROB) {
      lastSpeechAt = now;
      if (!speaking) {
        speaking = true;
        onSpeech(true);
      }
      return;
    }

    if (!speaking) return;
    if (probability > SPEECH_STOP_PROB) return;
    // Фора в начале записи: пока она не вышла, паузу не ставим.
    if (now - startedAt < LEAD_IN_MS) return;
    if (now - lastSpeechAt < HANGOVER_MS) return;

    speaking = false;
    onSpeech(false);
  }

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);

    // Порезать вход на кадры ровно по 512 отсчётов, храня остаток между
    // вызовами: длина буфера от кадра модели не зависит.
    for (let offset = 0; offset < input.length; ) {
      const take = Math.min(FRAME_SAMPLES - carried, input.length - offset);
      carry.set(input.subarray(offset, offset + take), carried);
      carried += take;
      offset += take;

      if (carried === FRAME_SAMPLES) {
        pending.push(new Float32Array(carry));
        carried = 0;
      }
    }

    // Если вывод модели не поспевает, старые кадры не нужны: гейт интересует
    // текущее состояние, а не история.
    if (pending.length > 8) pending = pending.slice(-4);
    pump();
  };

  source.connect(processor);
  // Без подключения к выходу ScriptProcessorNode не вызывается вовсе.
  // Нулевая громкость нужна, чтобы не пустить микрофон в динамик.
  const mute = context.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(context.destination);

  return {
    mode,
    async stop() {
      stopped = true;
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
      await context.close();
    },
  };
}

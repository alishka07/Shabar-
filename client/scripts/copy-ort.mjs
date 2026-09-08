/**
 * Раскладывает файлы среды выполнения ONNX по public/ort/.
 *
 * Почему копированием, а не хранением в репозитории: сам wasm весит около
 * 14 МБ, и класть его в git ради файла, который и так приезжает с npm, незачем.
 * Модель Silero (2,3 МБ) в репозитории лежит — её на npm нет.
 *
 * Запускается автоматически после `npm install` и перед сборкой.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'node_modules', 'onnxruntime-web', 'dist');
const to = join(here, '..', 'public', 'ort');

/**
 * Берём сборку только под wasm и с внешним, не встроенным двоичным файлом.
 *
 * Точка входа по умолчанию тянет вариант с поддержкой видеокарты, и сборщик
 * утаскивает в дистрибутив 27 МБ wasm, которые нам не нужны ни на одном
 * телефоне. Здесь — 49 КБ загрузчика и 14 МБ самого модуля, подгружаемого
 * по требованию при первой записи.
 *
 * Однопоточный режим (numThreads = 1 в vad.js) избавляет от требования
 * cross-origin isolation, которое иначе пришлось бы обслуживать заголовками.
 */
const FILES = [
  // Классическая, не модульная сборка: она подключается обычным тегом script и
  // объявляет глобальный `ort`. Модульный вариант Vite отказывается отдавать из
  // public через import(), а класть 14 МБ в дистрибутив ради этого незачем.
  'ort.wasm.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

if (!existsSync(from)) {
  console.warn('onnxruntime-web не установлен, пропускаем копирование среды ONNX');
  process.exit(0);
}

mkdirSync(to, { recursive: true });
for (const name of FILES) {
  copyFileSync(join(from, name), join(to, name));
}
console.log(`ONNX: скопировано файлов ${FILES.length} в public/ort/`);

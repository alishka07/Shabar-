/**
 * Шифрование локальной базы. День 7 плана.
 *
 * Состояние на сегодня: примитивы ниже рабочие и покрыты ручной проверкой, но
 * запись в Dexie идёт открытым текстом — вызовы не подключены к db.js. Это
 * известный незакрытый пункт, а не забытый. Если к питчу он останется таким,
 * говорим об этом прямо: «шифрования пока нет», а не молчим.
 *
 * Замысел, когда будем подключать: ключ выводится из ПИН-кода оператора через
 * PBKDF2, живёт только в памяти вкладки и исчезает при закрытии. Шифруются
 * описание донесения и байты вложений — то, что имеет ценность на потерянном
 * устройстве. Метаданные очереди остаются открытыми, иначе синхронизация не
 * сможет работать без введённого ПИН-кода.
 */

const PBKDF2_ITERATIONS = 250_000;
const SALT_KEY = 'khabar.kdf_salt';

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Соль устройства. Не секрет, но должна пережить перезапуск. */
function deviceSalt() {
  let stored = localStorage.getItem(SALT_KEY);
  if (!stored) {
    stored = toBase64(randomBytes(16));
    localStorage.setItem(SALT_KEY, stored);
  }
  return fromBase64(stored);
}

/** Ключ из ПИН-кода. Держать только в памяти, никуда не сохранять. */
export async function deriveKey(pin) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: deviceSalt(), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Шифрует произвольные байты. Возвращает { iv, data } для записи в базу. */
export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: toBase64(iv), data: new Uint8Array(data) };
}

export async function decryptBytes(key, { iv, data }) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    data,
  );
  return new Uint8Array(plain);
}

export async function encryptText(key, text) {
  return encryptBytes(key, new TextEncoder().encode(text));
}

export async function decryptText(key, payload) {
  return new TextDecoder().decode(await decryptBytes(key, payload));
}

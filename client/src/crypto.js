/**
 * Криптографические примитивы для локальной базы.
 *
 * Ключ выводится из ПИН-кода оператора через PBKDF2, живёт только в памяти
 * вкладки и исчезает при её закрытии. На диск он не попадает ни в каком виде:
 * в localStorage лежат только соль и контрольное значение для проверки ПИН-кода.
 *
 * Кто и что этим шифрует — см. `vault.js` (хранение ключа) и `db.js`
 * (что именно заворачивается перед записью в Dexie).
 */

const PBKDF2_ITERATIONS = 250_000;
const SALT_KEY = 'khabar.kdf_salt';

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Кусками: `String.fromCharCode(...bytes)` на длинном массиве роняет стек. */
export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

export function fromBase64(text) {
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

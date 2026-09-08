import { decryptText, deriveKey, encryptText, fromBase64, toBase64 } from './crypto.js';

/**
 * Хранилище ключа локальной базы.
 *
 * Ключ существует только в памяти вкладки. Закрыли приложение — ключа нет,
 * и без ПИН-кода из базы на устройстве не читается ничего, кроме служебных
 * полей очереди. Это и есть ответ на «устройство может быть потеряно».
 *
 * Прямое следствие, которое надо понимать и не прятать: пока оператор не ввёл
 * ПИН-код, синхронизация не идёт. Отправить донесение можно только расшифровав
 * его, а расшифровать — только ключом. Мы предпочли это варианту, в котором
 * ключ лежит рядом с данными: такой «шифрование» не защищает ни от чего.
 */

const VERIFIER_KEY = 'khabar.pin_verifier';

/** Контрольная фраза. Расшифровалась — ПИН верный, AES-GCM проверит целостность. */
const VERIFIER_PLAINTEXT = 'khabar-vault-v1';

export const MIN_PIN_LENGTH = 6;

let key = null;

export function isConfigured() {
  return localStorage.getItem(VERIFIER_KEY) !== null;
}

export function isUnlocked() {
  return key !== null;
}

/** Ключ для db.js. Заперто — это ошибка вызывающего, а не штатная ситуация. */
export function requireKey() {
  if (!key) throw new Error('локальная база заперта: ПИН-код не введён');
  return key;
}

export function lock() {
  key = null;
}

/** Первый запуск: оператор задаёт ПИН-код. */
export async function setupPin(pin) {
  if (pin.length < MIN_PIN_LENGTH) {
    throw new Error(`ПИН-код короче ${MIN_PIN_LENGTH} знаков`);
  }
  const candidate = await deriveKey(pin);
  const sealed = await encryptText(candidate, VERIFIER_PLAINTEXT);
  localStorage.setItem(
    VERIFIER_KEY,
    JSON.stringify({ iv: sealed.iv, data: toBase64(sealed.data) }),
  );
  key = candidate;
}

/** Возвращает true, если ПИН подошёл. Неверный ПИН — не исключение, а ответ. */
export async function unlock(pin) {
  const stored = localStorage.getItem(VERIFIER_KEY);
  if (!stored) return false;

  const { iv, data } = JSON.parse(stored);
  const candidate = await deriveKey(pin);
  try {
    const text = await decryptText(candidate, { iv, data: fromBase64(data) });
    if (text !== VERIFIER_PLAINTEXT) return false;
  } catch {
    // Провалившаяся проверка подлинности AES-GCM и есть «ПИН неверный».
    return false;
  }
  key = candidate;
  return true;
}

import { resealPlaintextRows, wipeLocalData } from '../db.js';
import { isConfigured, MIN_PIN_LENGTH, setupPin, unlock } from '../vault.js';

/**
 * Экран ПИН-кода. Первое, что видит оператор при запуске.
 *
 * До ввода кода приложение не показывает ни одного донесения: ключ от локальной
 * базы выводится из этого кода и нигде не хранится.
 */
export function renderLock(root, onUnlocked) {
  const configured = isConfigured();

  root.innerHTML = `
    <section class="card lock">
      <h2>${configured ? 'Локальная база заперта' : 'Задайте ПИН-код'}</h2>
      <p class="hint">
        ${
          configured
            ? 'Введите ПИН-код, чтобы открыть донесения и продолжить синхронизацию.'
            : `Ключ шифрования выводится из этого кода и никуда не записывается.
               Забытый ПИН-код означает потерю всех локальных донесений —
               восстановить их будет нечем.`
        }
      </p>

      <form id="lock-form">
        <label class="field">
          <span class="label">ПИН-код</span>
          <input id="pin" type="password" inputmode="numeric" autocomplete="off"
                 minlength="${MIN_PIN_LENGTH}" required />
        </label>

        ${
          configured
            ? ''
            : `<label class="field">
                 <span class="label">Повторите ПИН-код</span>
                 <input id="pin-repeat" type="password" inputmode="numeric"
                        autocomplete="off" minlength="${MIN_PIN_LENGTH}" required />
               </label>`
        }

        <div class="warn" id="lock-error" hidden></div>
        <button type="submit" class="primary big" id="lock-submit">
          ${configured ? 'Открыть' : 'Задать и войти'}
        </button>
      </form>
    </section>

    ${
      configured
        ? `<section class="card danger-card">
             <p class="hint">
               ПИН-код забыт или устройство нужно очистить прямо сейчас. Стирание
               доступно без ввода кода: в поле важнее суметь уничтожить данные,
               чем защитить их от уничтожения. Всё, что не успело уйти, будет
               потеряно безвозвратно.
             </p>
             <button class="danger" id="lock-wipe">Стереть все локальные данные</button>
           </section>`
        : ''
    }
  `;

  const form = root.querySelector('#lock-form');
  const pinInput = root.querySelector('#pin');
  const repeatInput = root.querySelector('#pin-repeat');
  const errorBox = root.querySelector('#lock-error');
  const submit = root.querySelector('#lock-submit');

  pinInput.focus();

  function fail(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
    pinInput.value = '';
    if (repeatInput) repeatInput.value = '';
    pinInput.focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const pin = pinInput.value;
    if (pin.length < MIN_PIN_LENGTH) {
      fail(`ПИН-код должен быть не короче ${MIN_PIN_LENGTH} знаков`);
      return;
    }
    if (repeatInput && repeatInput.value !== pin) {
      fail('Коды не совпали');
      return;
    }

    // Вывод ключа из ПИН-кода занимает заметное время, и это не баг:
    // медленный PBKDF2 — то, что делает подбор кода на изъятом устройстве дорогим.
    submit.disabled = true;
    submit.textContent = 'Открываем…';

    try {
      if (repeatInput) {
        await setupPin(pin);
      } else if (!(await unlock(pin))) {
        submit.disabled = false;
        submit.textContent = 'Открыть';
        fail('ПИН-код не подошёл');
        return;
      }
      await resealPlaintextRows();
      onUnlocked();
    } catch (error) {
      submit.disabled = false;
      submit.textContent = configured ? 'Открыть' : 'Задать и войти';
      fail(String(error.message || error));
    }
  });

  root.querySelector('#lock-wipe')?.addEventListener('click', async () => {
    if (!confirm('Стереть все локальные данные без возможности восстановления?')) return;
    await wipeLocalData();
    location.reload();
  });
}

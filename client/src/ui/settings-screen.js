import { author, deviceId, language, LANGUAGES, setAuthor, setLanguage } from '../config.js';
import { db, wipeLocalData } from '../db.js';
import { lock } from '../vault.js';
import { escapeHtml } from './html.js';

export async function renderSettings(root) {
  const [reports, attachments] = await Promise.all([db.reports.count(), db.attachments.count()]);

  root.innerHTML = `
    <section class="card">
      <h2>Устройство</h2>
      <label class="field">
        <span class="label">Позывной оператора</span>
        <input id="author" value="${escapeHtml(author())}" placeholder="Оператор 12" />
      </label>
      <p class="hint">Идентификатор устройства: <code>${escapeHtml(deviceId())}</code></p>
      <p class="hint">В локальной базе: донесений ${reports}, вложений ${attachments}.</p>
    </section>

    <section class="card">
      <h2>Язык голосового донесения</h2>
      <label class="field">
        <select id="language">
          ${LANGUAGES.map(
            (item) =>
              `<option value="${item.value}" ${
                item.value === language() ? 'selected' : ''
              }>${item.label}</option>`,
          ).join('')}
        </select>
      </label>
      <p class="hint">
        Язык уходит вместе с донесением и передаётся распознавателю на сервере.
        Выбор руками надёжнее автоопределения: на короткой записи с шумом и
        переходами между языками определитель ошибается чаще, чем оператор,
        который и так знает, на чём говорит.
      </p>
      <p class="hint">
        По-русски распознавание работает хорошо. По-казахски — слабо, а смешанную
        речь внутри одной фразы не держит ни одна открытая модель. Расшифровка на
        пункте управления — черновик рядом с исходным аудио, а не готовый ответ.
      </p>
    </section>

    <section class="card">
      <h2>Локальная база</h2>
      <p class="hint">
        Содержимое донесений и байты вложений зашифрованы AES-GCM. Ключ выводится
        из ПИН-кода при входе, живёт только в памяти вкладки и на диск не попадает.
        Открытыми остаются служебные поля очереди: сколько записей, какие срочные
        и когда созданы.
      </p>
      <button class="ghost" id="btn-lock">Запереть базу</button>
      <p class="hint">
        Смена ПИН-кода не сделана: она требует перешифровать всю базу.
        Пока единственный способ сменить код — стереть данные и задать новый.
      </p>
    </section>

    <section class="card danger-card">
      <h2>Быстрое стирание</h2>
      <p class="hint">
        Устройство может быть потеряно. Кнопка удаляет локальную базу, кэш карт и
        настройки без подтверждения на сервере и без возможности восстановления.
        Всё, что не успело уйти, будет потеряно.
      </p>
      <button class="danger" id="btn-wipe">Стереть все локальные данные</button>
    </section>

    <section class="card">
      <h2>Что здесь ещё не сделано</h2>
      <p class="hint">
        Расшифровка приходит текстом, но по полям донесения не раскладывается:
        <code>extract_fields</code> на сервере — заготовка. Об этом говорим прямо,
        а не умалчиваем.
      </p>
    </section>
  `;

  const authorInput = root.querySelector('#author');
  authorInput.addEventListener('change', () => setAuthor(authorInput.value.trim()));

  const languageSelect = root.querySelector('#language');
  languageSelect.addEventListener('change', () => setLanguage(languageSelect.value));

  root.querySelector('#btn-lock').addEventListener('click', () => {
    lock();
    // Перезапуск гарантирует, что расшифрованного не осталось ни на одном экране.
    location.reload();
  });

  root.querySelector('#btn-wipe').addEventListener('click', async () => {
    if (!confirm('Стереть все локальные данные без возможности восстановления?')) return;
    await wipeLocalData();
    location.reload();
  });
}

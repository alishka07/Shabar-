import { author, deviceId, setAuthor } from '../config.js';
import { db, wipeLocalData } from '../db.js';
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
        Локальная база пока не зашифрована: примитивы лежат в
        <code>src/crypto.js</code>, но к записи не подключены. Разбор голосового
        донесения на сервере — заглушка. Об этом говорим прямо, а не умалчиваем.
      </p>
    </section>
  `;

  const authorInput = root.querySelector('#author');
  authorInput.addEventListener('change', () => setAuthor(authorInput.value.trim()));

  root.querySelector('#btn-wipe').addEventListener('click', async () => {
    if (!confirm('Стереть все локальные данные без возможности восстановления?')) return;
    await wipeLocalData();
    location.reload();
  });
}

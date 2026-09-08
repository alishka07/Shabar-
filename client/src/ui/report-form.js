import {
  author,
  deviceId,
  nextReportNumber,
  POSITION_SOURCE_LABELS,
  PRIORITIES,
  REPORT_TYPES,
  SCHEMA_VERSION,
} from '../config.js';
import { saveReport } from '../db.js';
import {
  formatPosition,
  getPosition,
  hasCoordinates,
  NO_POSITION,
  positionFromMap,
} from '../geo.js';
import { compressPhoto, createRecorder, formatBytes, makeAttachment } from '../media.js';
import { sync } from '../sync.js';
import { createMap, L } from './map-common.js';

export function renderReportForm(root) {
  let position = NO_POSITION;
  let positionProblem = 'Координаты ещё не получены';
  let pendingFiles = [];
  let audioBlob = null;
  let pickerMap = null;
  let pickerMarker = null;
  const recorder = createRecorder();

  root.innerHTML = `
    <form class="card form" id="report-form">
      <label class="field">
        <span class="label">Тип донесения</span>
        <select name="type" required>
          ${REPORT_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('')}
        </select>
      </label>

      <label class="field">
        <span class="label">Описание</span>
        <textarea name="description" rows="3" placeholder="Что наблюдаете"></textarea>
      </label>

      <label class="field">
        <span class="label" id="quantity-label">Количество единиц</span>
        <input name="quantity" type="number" inputmode="numeric" />
      </label>

      <fieldset class="field">
        <span class="label">Приоритет</span>
        <div class="segmented">
          ${PRIORITIES.map(
            (p, index) => `
            <label class="segment">
              <input type="radio" name="priority" value="${p.value}" ${index === 0 ? 'checked' : ''} />
              <span>${p.label}</span>
            </label>`,
          ).join('')}
        </div>
      </fieldset>

      <section class="field position-block">
        <span class="label">Координаты</span>
        <div class="position-value" id="position-value">—</div>
        <div class="warn" id="position-warn" hidden></div>
        <div class="row">
          <button type="button" class="ghost" id="btn-gnss">Обновить с GNSS</button>
          <button type="button" class="ghost" id="btn-pick">Точка на карте</button>
        </div>
        <div class="picker" id="picker" hidden></div>
      </section>

      <section class="field">
        <span class="label">Фото</span>
        <input type="file" id="photo-input" accept="image/*" capture="environment" multiple />
        <ul class="chips" id="photo-list"></ul>
      </section>

      <section class="field">
        <span class="label">Голосовое донесение</span>
        <div class="row">
          <button type="button" class="ghost" id="btn-record">Записать</button>
          <span class="hint" id="audio-state">нет записи</span>
        </div>
        <p class="hint">Распознавание идёт на сервере после доставки: канал узкий, аудио уходит последним.</p>
      </section>

      <button type="submit" class="primary big">Сохранить донесение</button>
      <p class="saved" id="saved" hidden></p>
    </form>
  `;

  const form = root.querySelector('#report-form');
  const positionValue = root.querySelector('#position-value');
  const positionWarn = root.querySelector('#position-warn');
  const picker = root.querySelector('#picker');
  const photoList = root.querySelector('#photo-list');
  const savedBanner = root.querySelector('#saved');
  const quantityLabel = root.querySelector('#quantity-label');
  const audioState = root.querySelector('#audio-state');
  const recordButton = root.querySelector('#btn-record');

  function paintPosition() {
    const label = POSITION_SOURCE_LABELS[position.source] || position.source;
    positionValue.textContent = hasCoordinates(position)
      ? `${formatPosition(position)} · ${label}`
      : 'нет координат';
    positionValue.classList.toggle('is-missing', !hasCoordinates(position));

    positionWarn.hidden = !positionProblem;
    if (positionProblem) {
      // Приложение не молчит и не пишет мусор: говорит, что верить нельзя,
      // и предлагает поставить точку руками.
      positionWarn.textContent = `${positionProblem}. Поставьте точку на карте вручную.`;
    }
  }

  async function refreshFromGnss() {
    positionValue.textContent = 'запрашиваем спутник…';
    const result = await getPosition();
    position = result.position;
    positionProblem = result.problem;
    paintPosition();
  }

  function openPicker() {
    picker.hidden = false;
    if (pickerMap) {
      pickerMap.invalidateSize();
      return;
    }
    const center = hasCoordinates(position) ? [position.lat, position.lon] : undefined;
    pickerMap = createMap(picker, center ? { center } : {});
    pickerMap.on('click', (event) => {
      position = positionFromMap(event.latlng.lat, event.latlng.lng);
      positionProblem = null;
      if (pickerMarker) pickerMarker.remove();
      pickerMarker = L.marker(event.latlng).addTo(pickerMap);
      paintPosition();
    });
  }

  function paintPhotos() {
    photoList.innerHTML = pendingFiles
      .map((item, index) => `<li>${item.name} · ${formatBytes(item.blob.size)}
        <button type="button" data-remove="${index}" aria-label="Убрать">×</button></li>`)
      .join('');
  }

  root.querySelector('#btn-gnss').addEventListener('click', refreshFromGnss);
  root.querySelector('#btn-pick').addEventListener('click', openPicker);

  const typeSelect = form.elements.namedItem('type');
  typeSelect.addEventListener('change', () => {
    const type = REPORT_TYPES.find((item) => item.value === typeSelect.value);
    quantityLabel.textContent = type?.quantityLabel || 'Количество';
  });

  root.querySelector('#photo-input').addEventListener('change', async (event) => {
    for (const file of event.target.files) {
      // Сжимаем сразу: в двадцать секунд связи должно поместиться как можно больше.
      const blob = await compressPhoto(file);
      pendingFiles.push({ name: file.name, blob });
    }
    event.target.value = '';
    paintPhotos();
  });

  photoList.addEventListener('click', (event) => {
    const index = event.target.dataset.remove;
    if (index == null) return;
    pendingFiles.splice(Number(index), 1);
    paintPhotos();
  });

  recordButton.addEventListener('click', async () => {
    if (recorder.recording) {
      audioBlob = await recorder.stop();
      recordButton.textContent = 'Записать заново';
      recordButton.classList.remove('recording');
      audioState.textContent = audioBlob ? `запись ${formatBytes(audioBlob.size)}` : 'нет записи';
      return;
    }
    try {
      await recorder.start();
      recordButton.textContent = 'Остановить';
      recordButton.classList.add('recording');
      audioState.textContent = 'идёт запись…';
    } catch {
      audioState.textContent = 'микрофон недоступен';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const reportId = crypto.randomUUID();

    const report = {
      // UUID рождается здесь, до всякой связи. Именно он потом отбивает дубли.
      id: reportId,
      number: nextReportNumber(),
      schema_version: SCHEMA_VERSION,
      device_id: deviceId(),
      author: author(),
      type: data.get('type'),
      priority: data.get('priority'),
      description: (data.get('description') || '').trim(),
      quantity: data.get('quantity') ? Number(data.get('quantity')) : null,
      created_at_device: new Date().toISOString(),
      position,
      sync_state: 'queued',
      last_error: null,
    };

    const attachments = pendingFiles.map(({ blob }) =>
      makeAttachment({ reportId, kind: 'photo', blob, contentType: 'image/jpeg' }),
    );
    if (audioBlob) {
      attachments.push(makeAttachment({ reportId, kind: 'audio', blob: audioBlob }));
    }

    await saveReport(report, attachments);

    savedBanner.hidden = false;
    savedBanner.textContent = 'Сохранено локально, ожидает отправки';
    form.reset();
    pendingFiles = [];
    audioBlob = null;
    audioState.textContent = 'нет записи';
    recordButton.textContent = 'Записать';
    paintPhotos();
    // Если канал есть — уйдёт сразу. Если нет — полежит в очереди.
    sync();
    refreshFromGnss();
  });

  paintPosition();
  refreshFromGnss();
}

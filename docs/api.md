# Контракт с сервером

Три метода, больше не нужно. Плюс дешёвая проба канала и отдача вложений панели.

Всё общение — по HTTPS. Базовый путь `/api/v1`.

---

## Отправка пачки донесений

```
POST /api/v1/sync/reports
Content-Type: application/json

[ { ...донесение... }, { ...донесение... } ]
```

Ответ — результат по каждому элементу, в любом порядке:

```json
[
  { "id": "9f1c...", "result": "accepted" },
  { "id": "3a7d...", "result": "duplicate" },
  { "id": "77bb...", "result": "rejected", "reason": "schema_version",
    "expected_schema_version": 1 }
]
```

`duplicate` для клиента — успех. Запись помечается отправленной.

Значения `reason` для `rejected`: `schema_version`, `validation`, `malformed`.
При `validation` рядом лежит `details` с полями, не прошедшими разбор.

Каждый элемент обрабатывается независимо и в своей транзакции. Одно кривое
донесение не отменяет всю пачку.

### Почему повтор безопасен

`id` — UUID, сгенерированный на клиенте в момент создания записи, задолго до
первой попытки отправки. В базе сервера это первичный ключ. Повторная отправка
той же записи упирается в уникальный индекс и возвращает `duplicate`.

Никакой дополнительной логики дедупликации нет и не нужно. Это ответ на главный
вопрос к любой офлайн-системе: что будет, если связь оборвётся ровно посередине
отправки. Ничего.

### Тело донесения

```json
{
  "id": "9f1c2b7e-4d3a-4c11-9c8e-0a2b6d5e7f10",
  "schema_version": 1,
  "device_id": "dev-014",
  "author": "Оператор 12",
  "type": "equipment_fault",
  "priority": "urgent",
  "description": "Отказ радиостанции на машине 3",
  "created_at_device": "2026-09-12T14:32:11+05:00",
  "position": {
    "lat": 51.1234,
    "lon": 71.4567,
    "accuracy_m": 12,
    "source": "gnss"
  },
  "quantity": 1,
  "language": "ru",
  "attachments": [
    { "id": "1b0d1f4a-2c3e-4d5f-8a9b-0c1d2e3f4a5b",
      "kind": "photo", "bytes": 184320, "content_type": "image/jpeg" }
  ]
}
```

- `type`: `detection`, `unit_status`, `equipment_fault`, `supply_request`, `incident`.
- `priority`: `routine`, `urgent`.
- `position.source`: `gnss`, `manual`, `map`, `none`.
- `language`: `ru`, `kk`, `auto`. Язык голосового донесения, оператор выбирает
  его в приложении. Поле необязательное, умолчание `ru`, поэтому клиент,
  который о нём не знает, продолжает работать и `schema_version` не меняется.
- `attachments[].id` — тоже UUID с клиента: он адресует куски при догрузке.
  Байты в этом теле не передаются, только объявление о намерении их догрузить.
- `received_at_server` клиент не присылает, сервер проставляет сам.
- `sync_state` живёт только на клиенте и на сервер не отправляется.

Расхождение `created_at_device` и `received_at_server` — это возраст донесения,
пролежавшего в очереди без связи. Панель показывает оба времени.

---

## Догрузка вложения кусками

```
POST /api/v1/sync/attachments/{attachment_id}/chunk?offset=262144
Content-Type: application/octet-stream

<сырые байты куска>
```

Ответ:

```json
{
  "attachment_id": "1b0d...",
  "received_bytes": 327680,
  "declared_bytes": 184320,
  "complete": false
}
```

`received_bytes` — единственный источник правды о том, сколько принято. Клиент
после обрыва продолжает с этого числа, а не с начала файла.

Правила по `offset`:

| Случай | Что делает сервер |
|---|---|
| `offset == received_bytes` | пишет кусок целиком |
| `offset < received_bytes` | повтор после обрыва: отрезает пересечение, пишет только новый хвост |
| `offset > received_bytes` | `409` с телом `{"error": "gap", "received_bytes": N}` — дыру нулями не заполняет |

Текущее состояние можно спросить, ничего не отправляя:

```
GET /api/v1/sync/attachments/{attachment_id}/chunk
```

Когда аудиовложение принято целиком, сервер запускает разбор речи
(`server/reports/asr.py`) в фоновом потоке и кладёт результат в `transcript`.
Ответ клиенту при этом не ждёт распознавания: держать соединение с телефоном в
поле на десятки секунд нельзя.

Ход разбора виден в `transcript_status`: `pending` (принято, ждёт), `running`
(распознаётся), `done`, `failed`, `disabled` (распознавание на сервере
выключено). Панель управления опрашивает список и показывает статус, пока текста
нет.

---

## Чтение для панели управления

```
GET /api/v1/reports?since=2026-09-12T00:00:00Z&type=detection&priority=urgent
```

Все параметры необязательны. `since` фильтрует по `received_at_server`, а не по
времени устройства: панель интересует, что появилось нового у неё. Донесение
при этом могло быть создано в поле сутки назад.

Возвращает до 500 записей, новые по приёму — первыми. Вложения приходят
вложенным списком с `received_bytes`, `complete` и `transcript`.

Содержимое принятого вложения:

```
GET /api/v1/attachments/{attachment_id}/content
```

---

## Проба канала

```
GET /api/v1/health   ->  {"ok": true, "schema_version": 1}
```

`navigator.onLine` в браузере говорит лишь о наличии сетевого интерфейса: Wi-Fi
без выхода наружу он считает сетью. Клиент перед синхронизацией дёргает
`/health` и решает по факту ответа.

---

## Проверка руками

```bash
# Идемпотентность: два одинаковых запроса — одна запись.
curl -X POST http://localhost:8000/api/v1/sync/reports \
  -H 'Content-Type: application/json' -d @docs/samples/report.json
curl -X POST http://localhost:8000/api/v1/sync/reports \
  -H 'Content-Type: application/json' -d @docs/samples/report.json

# Докачка: два куска по 6 байт, второй с места обрыва.
ATT=1b0d1f4a-2c3e-4d5f-8a9b-0c1d2e3f4a5b
curl -X POST "http://localhost:8000/api/v1/sync/attachments/$ATT/chunk?offset=0" \
  -H 'Content-Type: application/octet-stream' --data-binary '012345'
curl "http://localhost:8000/api/v1/sync/attachments/$ATT/chunk"
curl -X POST "http://localhost:8000/api/v1/sync/attachments/$ATT/chunk?offset=6" \
  -H 'Content-Type: application/octet-stream' --data-binary '6789ab'
```

Те же сценарии в автотестах: `server/reports/tests.py`.

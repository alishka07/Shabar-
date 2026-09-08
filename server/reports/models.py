from pathlib import Path

from django.conf import settings
from django.db import models

SCHEMA_VERSION = 1

REPORT_TYPES = [
    ("detection", "Обнаружение"),
    ("unit_status", "Состояние подразделения"),
    ("equipment_fault", "Неисправность техники"),
    ("supply_request", "Запрос обеспечения"),
    ("incident", "Происшествие"),
]

PRIORITIES = [("routine", "Обычный"), ("urgent", "Срочный")]

POSITION_SOURCES = [
    ("gnss", "Спутник"),
    ("manual", "Вручную"),
    ("map", "Точка на карте"),
    ("none", "Нет координат"),
]

ATTACHMENT_KINDS = [("photo", "Фото"), ("audio", "Аудио")]

# Язык голосового донесения. Оператор выбирает его в настройках приложения:
# автоопределение на короткой зашумлённой записи с переключением языков
# ошибается чаще, чем человек, который и так знает, на чём говорит.
LANGUAGES = [("ru", "Русский"), ("kk", "Қазақша"), ("auto", "Определять автоматически")]

TRANSCRIPT_STATUSES = [
    ("pending", "Ожидает"),
    ("running", "Распознаётся"),
    ("done", "Готово"),
    ("failed", "Ошибка"),
    ("disabled", "Распознавание выключено"),
]


class Report(models.Model):
    """Донесение.

    Первичный ключ приходит с клиента и генерируется в момент создания записи,
    до всякой попытки отправки. Уникальный индекс по нему — вся защита от дублей:
    повторная отправка той же записи не создаёт вторую строку. Ничего больше для
    идемпотентности не нужно.
    """

    id = models.UUIDField(primary_key=True, editable=False)
    schema_version = models.IntegerField(default=SCHEMA_VERSION)

    device_id = models.CharField(max_length=64)
    author = models.CharField(max_length=128, blank=True)

    type = models.CharField(max_length=32, choices=REPORT_TYPES)
    priority = models.CharField(max_length=16, choices=PRIORITIES, default="routine")
    description = models.TextField(blank=True)
    quantity = models.IntegerField(null=True, blank=True)
    language = models.CharField(max_length=8, choices=LANGUAGES, default="ru")

    # Время устройства и время сервера разведены намеренно: разрыв между ними —
    # это и есть возраст донесения, пролежавшего в очереди без связи.
    created_at_device = models.DateTimeField()
    received_at_server = models.DateTimeField(auto_now_add=True)

    lat = models.FloatField(null=True, blank=True)
    lon = models.FloatField(null=True, blank=True)
    accuracy_m = models.FloatField(null=True, blank=True)
    position_source = models.CharField(
        max_length=16, choices=POSITION_SOURCES, default="none"
    )

    class Meta:
        ordering = ["-created_at_device"]
        indexes = [
            models.Index(fields=["received_at_server"]),
            models.Index(fields=["type", "priority"]),
        ]

    def __str__(self):
        return f"{self.get_type_display()} {self.id}"


class Attachment(models.Model):
    """Фото или аудио, догружаемое кусками после самого донесения.

    `received_bytes` — единственный источник правды о том, сколько сервер уже
    принял. Клиент после обрыва спрашивает это число и продолжает с него,
    а не начинает файл заново.
    """

    id = models.UUIDField(primary_key=True, editable=False)
    report = models.ForeignKey(
        Report, related_name="attachments", on_delete=models.CASCADE
    )
    kind = models.CharField(max_length=16, choices=ATTACHMENT_KINDS)
    content_type = models.CharField(max_length=64, blank=True)
    declared_bytes = models.BigIntegerField(default=0)
    received_bytes = models.BigIntegerField(default=0)
    complete = models.BooleanField(default=False)

    # Заполняется разбором аудио на сервере, см. reports/asr.py.
    transcript = models.TextField(blank=True)
    transcript_status = models.CharField(
        max_length=16, choices=TRANSCRIPT_STATUSES, default="pending"
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    @property
    def storage_path(self) -> Path:
        directory = Path(settings.MEDIA_ROOT) / "attachments" / str(self.report_id)
        directory.mkdir(parents=True, exist_ok=True)
        return directory / str(self.id)

    def __str__(self):
        return f"{self.kind} {self.id} ({self.received_bytes}/{self.declared_bytes})"

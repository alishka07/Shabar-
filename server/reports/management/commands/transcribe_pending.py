"""Догнать расшифровки, которых нет.

Нужно ровно в одном сценарии, зато в важном: демо прошло с выключенным
распознаванием, аудио доехало и лежит, а расшифровку хочется получить потом.
Запускается вручную и работает по уже принятым вложениям, ничего не скачивая
с устройств заново.

    python manage.py transcribe_pending
    python manage.py transcribe_pending --retry-failed
"""

from django.core.management.base import BaseCommand

from reports.asr import is_enabled, transcribe
from reports.models import Attachment


class Command(BaseCommand):
    help = "Распознать принятые аудиовложения, у которых нет расшифровки"

    def add_arguments(self, parser):
        parser.add_argument(
            "--retry-failed",
            action="store_true",
            help="Взять и те вложения, на которых распознавание уже падало",
        )

    def handle(self, *args, **options):
        if not is_enabled():
            self.stderr.write(
                self.style.ERROR(
                    "Распознавание выключено. Запустите с KHABAR_ASR_ENABLED=1."
                )
            )
            return

        statuses = ["pending", "disabled"]
        if options["retry_failed"]:
            statuses.append("failed")

        pending = Attachment.objects.select_related("report").filter(
            kind="audio", complete=True, transcript_status__in=statuses
        )

        if not pending:
            self.stdout.write("Нечего распознавать.")
            return

        for attachment in pending:
            self.stdout.write(f"{attachment.id} … ", ending="")
            try:
                text = transcribe(attachment)
            except Exception as error:  # noqa: BLE001 — одно вложение не должно рвать прогон
                attachment.transcript_status = "failed"
                attachment.transcript = f"ошибка распознавания: {error}"
                attachment.save(update_fields=["transcript_status", "transcript"])
                self.stdout.write(self.style.ERROR(f"ошибка: {error}"))
                continue

            attachment.transcript = text
            attachment.transcript_status = "done"
            attachment.save(update_fields=["transcript", "transcript_status"])
            self.stdout.write(self.style.SUCCESS(f"{len(text)} символов"))

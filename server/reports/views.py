import logging

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import FileResponse, Http404
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.parsers import BaseParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .asr import transcribe_in_background
from .models import SCHEMA_VERSION, Attachment, Report
from .serializers import ReportInSerializer, ReportOutSerializer

log = logging.getLogger(__name__)


class OctetStreamParser(BaseParser):
    """Сырое тело запроса. Чанк вложения приходит байтами, без обёрток."""

    media_type = "application/octet-stream"

    def parse(self, stream, media_type=None, parser_context=None):
        return stream.read()


def get_attachment(attachment_id, *, for_update=False):
    """Вложение по id из URL.

    Кривой UUID в пути — это не пятисотка, а просто неизвестное вложение,
    поэтому ValidationError разбора ловим здесь же.
    """
    queryset = Attachment.objects.all()
    if for_update:
        queryset = queryset.select_for_update()
    try:
        return queryset.get(pk=attachment_id)
    except (Attachment.DoesNotExist, ValidationError, ValueError):
        raise Http404("unknown attachment")


def attachment_state(attachment):
    return {
        "attachment_id": str(attachment.id),
        "received_bytes": attachment.received_bytes,
        "declared_bytes": attachment.declared_bytes,
        "complete": attachment.complete,
    }


class HealthView(APIView):
    """Дешёвая проба канала.

    navigator.onLine врёт: Wi-Fi без выхода наружу он считает сетью. Клиент
    перед синхронизацией дёргает этот метод и решает по факту ответа.
    """

    def get(self, request):
        return Response({"ok": True, "schema_version": SCHEMA_VERSION})


class SyncReportsView(APIView):
    """POST /api/v1/sync/reports — приём пачки донесений.

    Каждый элемент обрабатывается независимо и в своей транзакции: одно кривое
    донесение не должно ронять всю пачку. Ответ — результат по каждому id.
    """

    def post(self, request):
        items = request.data if isinstance(request.data, list) else [request.data]
        return Response([self._accept(raw) for raw in items])

    def _accept(self, raw):
        if not isinstance(raw, dict):
            return {"id": None, "result": "rejected", "reason": "malformed"}

        if raw.get("schema_version") != SCHEMA_VERSION:
            return {
                "id": raw.get("id"),
                "result": "rejected",
                "reason": "schema_version",
                "expected_schema_version": SCHEMA_VERSION,
            }

        serializer = ReportInSerializer(data=raw)
        if not serializer.is_valid():
            return {
                "id": raw.get("id"),
                "result": "rejected",
                "reason": "validation",
                "details": serializer.errors,
            }

        report_id = str(serializer.validated_data["id"])

        if Report.objects.filter(pk=report_id).exists():
            return {"id": report_id, "result": "duplicate"}

        try:
            with transaction.atomic():
                serializer.save()
        except IntegrityError:
            # Две попытки отправки разошлись по времени и встретились здесь.
            # Уникальный индекс отработал, для клиента это тот же успех.
            return {"id": report_id, "result": "duplicate"}

        log.info("report accepted id=%s priority=%s", report_id, raw.get("priority"))
        return {"id": report_id, "result": "accepted"}


class AttachmentChunkView(APIView):
    """POST /api/v1/sync/attachments/{id}/chunk?offset=N — кусок вложения.

    Ответ всегда содержит `received_bytes`. Это и есть точка продолжения:
    после любого обрыва клиент шлёт следующий кусок с этого смещения.
    """

    parser_classes = [OctetStreamParser]

    def get(self, request, attachment_id):
        """Сколько байт уже принято. Клиент спрашивает перед докачкой."""
        return Response(attachment_state(get_attachment(attachment_id)))

    def post(self, request, attachment_id):
        try:
            offset = int(request.query_params.get("offset", 0))
        except ValueError:
            return Response(
                {"error": "offset must be an integer"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if offset < 0:
            return Response(
                {"error": "offset must be non-negative"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        chunk = request.data if isinstance(request.data, bytes) else b""
        became_complete = False

        with transaction.atomic():
            attachment = get_attachment(attachment_id, for_update=True)
            already = attachment.received_bytes

            if offset > already:
                # Клиент пропустил кусок. Не склеиваем дыру нулями — говорим,
                # с какого места продолжать.
                payload = attachment_state(attachment)
                payload["error"] = "gap"
                return Response(payload, status=status.HTTP_409_CONFLICT)

            # offset < already означает повторную отправку уже принятого куска
            # после обрыва. Отрезаем пересечение и пишем только новый хвост.
            overlap = already - offset
            if overlap:
                chunk = chunk[overlap:]

            limit = settings.KHABAR_MAX_ATTACHMENT_BYTES
            if already + len(chunk) > limit:
                return Response(
                    {"error": "attachment too large", "limit_bytes": limit},
                    status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                )

            if chunk:
                path = attachment.storage_path
                with open(path, "r+b" if path.exists() else "wb") as handle:
                    handle.seek(already)
                    handle.write(chunk)
                attachment.received_bytes = already + len(chunk)

            declared = attachment.declared_bytes
            if declared and attachment.received_bytes >= declared:
                became_complete = not attachment.complete
                attachment.complete = True

            attachment.save(update_fields=["received_bytes", "complete"])

        if became_complete and attachment.kind == "audio":
            # Разбор речи живёт на сервере намеренно: канал узкий, аудио уходит
            # последним, модели на устройстве нет. Уходит в фоновый поток —
            # держать соединение с телефоном на время распознавания нельзя.
            transcribe_in_background(attachment.id)

        return Response(attachment_state(attachment))


class AttachmentContentView(APIView):
    """Отдача принятого вложения панели пункта управления."""

    def get(self, request, attachment_id):
        attachment = get_attachment(attachment_id)
        path = attachment.storage_path
        if not path.exists():
            raise Http404("no bytes received yet")
        return FileResponse(
            open(path, "rb"),
            content_type=attachment.content_type or "application/octet-stream",
        )


class ReportListView(APIView):
    """GET /api/v1/reports?since=... — чтение для панели управления.

    Фильтр по времени приёма сервером, а не по времени устройства: панель
    хочет знать, что появилось нового у неё, а донесение могло быть создано
    в поле сутки назад.
    """

    def get(self, request):
        queryset = Report.objects.prefetch_related("attachments")

        since = request.query_params.get("since")
        if since:
            parsed = parse_datetime(since)
            if parsed is None:
                return Response(
                    {"error": "since must be an ISO 8601 datetime"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            queryset = queryset.filter(received_at_server__gt=parsed)

        report_type = request.query_params.get("type")
        if report_type:
            queryset = queryset.filter(type=report_type)

        priority = request.query_params.get("priority")
        if priority:
            queryset = queryset.filter(priority=priority)

        queryset = queryset.order_by("-received_at_server")[:500]
        return Response(ReportOutSerializer(queryset, many=True).data)

from rest_framework import serializers

from .models import (
    ATTACHMENT_KINDS,
    LANGUAGES,
    POSITION_SOURCES,
    PRIORITIES,
    REPORT_TYPES,
    Attachment,
    Report,
)


class PositionSerializer(serializers.Serializer):
    lat = serializers.FloatField(allow_null=True, required=False)
    lon = serializers.FloatField(allow_null=True, required=False)
    accuracy_m = serializers.FloatField(allow_null=True, required=False)
    source = serializers.ChoiceField(
        choices=POSITION_SOURCES, required=False, default="none"
    )


class AttachmentInSerializer(serializers.Serializer):
    """Вложение в теле донесения — только объявление о намерении догрузить.

    Байты сюда не попадают: они уходят отдельным методом, кусками.
    """

    id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=ATTACHMENT_KINDS)
    bytes = serializers.IntegerField(min_value=0, default=0)
    content_type = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )


class ReportInSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    schema_version = serializers.IntegerField()
    device_id = serializers.CharField(max_length=64)
    author = serializers.CharField(max_length=128, required=False, allow_blank=True)
    type = serializers.ChoiceField(choices=REPORT_TYPES)
    priority = serializers.ChoiceField(choices=PRIORITIES, default="routine")
    description = serializers.CharField(required=False, allow_blank=True, default="")
    quantity = serializers.IntegerField(required=False, allow_null=True)
    # Поле добавлено после первой версии контракта. Оно необязательное и с
    # умолчанием, поэтому старый клиент продолжает работать без него и
    # schema_version повышать не нужно.
    language = serializers.ChoiceField(choices=LANGUAGES, required=False, default="ru")
    created_at_device = serializers.DateTimeField()
    position = PositionSerializer(required=False, allow_null=True)
    attachments = AttachmentInSerializer(many=True, required=False, default=list)

    def create(self, validated):
        position = validated.pop("position", None) or {}
        attachments = validated.pop("attachments", [])
        # sync_state живёт только на клиенте и на сервер не отправляется;
        # если он всё же пришёл, мы его уже отбросили как неизвестное поле.
        report = Report.objects.create(
            id=validated["id"],
            schema_version=validated["schema_version"],
            device_id=validated["device_id"],
            author=validated.get("author", ""),
            type=validated["type"],
            priority=validated.get("priority", "routine"),
            description=validated.get("description", ""),
            quantity=validated.get("quantity"),
            language=validated.get("language", "ru"),
            created_at_device=validated["created_at_device"],
            lat=position.get("lat"),
            lon=position.get("lon"),
            accuracy_m=position.get("accuracy_m"),
            position_source=position.get("source", "none"),
        )
        Attachment.objects.bulk_create(
            Attachment(
                id=item["id"],
                report=report,
                kind=item["kind"],
                declared_bytes=item.get("bytes", 0),
                content_type=item.get("content_type", ""),
            )
            for item in attachments
        )
        return report


class AttachmentOutSerializer(serializers.ModelSerializer):
    class Meta:
        model = Attachment
        fields = [
            "id",
            "kind",
            "content_type",
            "declared_bytes",
            "received_bytes",
            "complete",
            "transcript",
            "transcript_status",
        ]


class ReportOutSerializer(serializers.ModelSerializer):
    position = serializers.SerializerMethodField()
    attachments = AttachmentOutSerializer(many=True, read_only=True)

    class Meta:
        model = Report
        fields = [
            "id",
            "schema_version",
            "device_id",
            "author",
            "type",
            "priority",
            "description",
            "quantity",
            "language",
            "created_at_device",
            "received_at_server",
            "position",
            "attachments",
        ]

    def get_position(self, obj):
        return {
            "lat": obj.lat,
            "lon": obj.lon,
            "accuracy_m": obj.accuracy_m,
            "source": obj.position_source,
        }

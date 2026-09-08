from django.contrib import admin

from .models import Attachment, Report


class AttachmentInline(admin.TabularInline):
    model = Attachment
    extra = 0
    readonly_fields = ["received_bytes", "declared_bytes", "complete", "transcript"]


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "type",
        "priority",
        "created_at_device",
        "received_at_server",
        "position_source",
    ]
    list_filter = ["type", "priority", "position_source"]
    search_fields = ["id", "description", "device_id", "author"]
    inlines = [AttachmentInline]


@admin.register(Attachment)
class AttachmentAdmin(admin.ModelAdmin):
    list_display = ["id", "report", "kind", "received_bytes", "declared_bytes", "complete"]
    list_filter = ["kind", "complete"]

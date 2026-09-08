from django.urls import path

from . import views

urlpatterns = [
    path("health", views.HealthView.as_view(), name="health"),
    path("sync/reports", views.SyncReportsView.as_view(), name="sync-reports"),
    path(
        "sync/attachments/<str:attachment_id>/chunk",
        views.AttachmentChunkView.as_view(),
        name="attachment-chunk",
    ),
    path(
        "attachments/<str:attachment_id>/content",
        views.AttachmentContentView.as_view(),
        name="attachment-content",
    ),
    path("reports", views.ReportListView.as_view(), name="report-list"),
]

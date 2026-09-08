"""Тесты на то, что не режется никогда: идемпотентность и докачка.

Всё остальное можно проверить глазами на демо. Эти два — нельзя.
"""

import tempfile
import uuid
from urllib.parse import quote

from django.test import TestCase, override_settings
from django.urls import reverse

from .models import Attachment, Report

REPORT_ID = "9f1c2b7e-4d3a-4c11-9c8e-0a2b6d5e7f10"
ATTACHMENT_ID = "1b0d1f4a-2c3e-4d5f-8a9b-0c1d2e3f4a5b"


def sample_report(**overrides):
    payload = {
        "id": REPORT_ID,
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
            "source": "gnss",
        },
        "quantity": 1,
        "attachments": [
            {
                "id": ATTACHMENT_ID,
                "kind": "photo",
                "bytes": 12,
                "content_type": "image/jpeg",
            }
        ],
    }
    payload.update(overrides)
    return payload


class SyncReportsTests(TestCase):
    def post(self, payload):
        return self.client.post(
            reverse("sync-reports"), payload, content_type="application/json"
        )

    def test_first_send_is_accepted(self):
        response = self.post([sample_report()])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [{"id": REPORT_ID, "result": "accepted"}])
        self.assertEqual(Report.objects.count(), 1)

    def test_repeat_send_is_duplicate_and_creates_no_second_row(self):
        """Связь оборвалась ровно посередине отправки, клиент повторил."""
        self.post([sample_report()])
        response = self.post([sample_report()])

        self.assertEqual(response.json(), [{"id": REPORT_ID, "result": "duplicate"}])
        self.assertEqual(Report.objects.count(), 1)

    def test_batch_keeps_good_items_when_one_is_bad(self):
        good = sample_report(id=str(uuid.uuid4()), attachments=[])
        bad = sample_report(id=str(uuid.uuid4()), type="не_из_справочника", attachments=[])

        results = self.post([good, bad]).json()

        self.assertEqual(results[0]["result"], "accepted")
        self.assertEqual(results[1]["result"], "rejected")
        self.assertEqual(results[1]["reason"], "validation")
        self.assertEqual(Report.objects.count(), 1)

    def test_unknown_schema_version_is_rejected_with_reason(self):
        results = self.post([sample_report(schema_version=99)]).json()

        self.assertEqual(results[0]["reason"], "schema_version")
        self.assertEqual(Report.objects.count(), 0)

    def test_position_source_survives_round_trip(self):
        self.post([sample_report(position={"lat": 51.0, "lon": 71.0, "source": "map"})])

        report = Report.objects.get(pk=REPORT_ID)
        self.assertEqual(report.position_source, "map")


class AttachmentChunkTests(TestCase):
    def setUp(self):
        # Байты вложений живут на диске, а не в базе, поэтому откат транзакции
        # между тестами их не убирает. Каждому тесту — свой MEDIA_ROOT.
        media_root = tempfile.TemporaryDirectory()
        self.addCleanup(media_root.cleanup)
        patched = override_settings(MEDIA_ROOT=media_root.name)
        patched.enable()
        self.addCleanup(patched.disable)

        self.client.post(
            reverse("sync-reports"),
            [sample_report()],
            content_type="application/json",
        )
        self.url = reverse("attachment-chunk", args=[ATTACHMENT_ID])

    def send(self, data, offset):
        return self.client.post(
            f"{self.url}?offset={offset}",
            data=data,
            content_type="application/octet-stream",
        )

    def test_upload_resumes_from_received_bytes(self):
        """Оборвали связь на середине фото — докачалось, а не началось заново."""
        first = self.send(b"012345", 0)
        self.assertEqual(first.json()["received_bytes"], 6)
        self.assertFalse(first.json()["complete"])

        # Клиент вернулся после обрыва и спросил, с чего продолжать.
        resume_from = self.client.get(self.url).json()["received_bytes"]
        self.assertEqual(resume_from, 6)

        second = self.send(b"6789ab", resume_from)
        self.assertEqual(second.json()["received_bytes"], 12)
        self.assertTrue(second.json()["complete"])

        attachment = Attachment.objects.get(pk=ATTACHMENT_ID)
        self.assertEqual(attachment.storage_path.read_bytes(), b"0123456789ab")

    def test_resent_chunk_does_not_duplicate_bytes(self):
        """Ответ на первый кусок потерялся, клиент отправил его снова."""
        self.send(b"012345", 0)
        response = self.send(b"012345", 0)

        self.assertEqual(response.json()["received_bytes"], 6)
        self.assertEqual(
            Attachment.objects.get(pk=ATTACHMENT_ID).storage_path.read_bytes(),
            b"012345",
        )

    def test_overlapping_chunk_writes_only_the_new_tail(self):
        self.send(b"0123", 0)
        response = self.send(b"23456789ab", 2)

        self.assertEqual(response.json()["received_bytes"], 12)
        self.assertEqual(
            Attachment.objects.get(pk=ATTACHMENT_ID).storage_path.read_bytes(),
            b"0123456789ab",
        )

    def test_gap_is_refused_with_the_resume_point(self):
        self.send(b"0123", 0)
        response = self.send(b"89ab", 8)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], "gap")
        self.assertEqual(response.json()["received_bytes"], 4)

    def test_unknown_attachment_is_404(self):
        url = reverse("attachment-chunk", args=[str(uuid.uuid4())])
        self.assertEqual(self.client.get(url).status_code, 404)


class ReportListTests(TestCase):
    def test_since_filters_by_server_receipt_time(self):
        self.client.post(
            reverse("sync-reports"),
            [sample_report()],
            content_type="application/json",
        )
        received_at = Report.objects.get(pk=REPORT_ID).received_at_server

        url = reverse("report-list")
        self.assertEqual(len(self.client.get(url).json()), 1)

        after = quote(received_at.isoformat())
        self.assertEqual(len(self.client.get(f"{url}?since={after}").json()), 0)

    def test_filters_by_type_and_priority(self):
        self.client.post(
            reverse("sync-reports"),
            [
                sample_report(attachments=[]),
                sample_report(
                    id=str(uuid.uuid4()),
                    type="detection",
                    priority="routine",
                    attachments=[],
                ),
            ],
            content_type="application/json",
        )

        url = reverse("report-list")
        self.assertEqual(len(self.client.get(f"{url}?priority=urgent").json()), 1)
        self.assertEqual(len(self.client.get(f"{url}?type=detection").json()), 1)

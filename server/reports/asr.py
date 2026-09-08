"""Разбор голосового донесения.

Почему на сервере, а не на телефоне: модель на устройстве весит десятки
мегабайт, качество по казахской и смешанной речи низкое, а канал узкий и гнать
по нему аудио первым приоритетом нельзя. Аудио уходит последним, разбирается
здесь.

Реализация — faster-whisper (Whisper на CTranslate2). Модель загружается лениво,
при первом же аудиовложении, и остаётся в памяти процесса. Пока распознавание не
включено, всё поведение сохраняется: вложение принимается, статус честно говорит
`disabled`, расшифровки нет.

Про качество говорим прямо, а не рекламируем. По-русски Whisper работает хорошо.
По-казахски — слабо: язык низкоресурсный для этой модели. Смешанную казахско-
русскую речь внутри одной фразы не держит ни одна открытая модель. Поэтому
расшифровка на панели управления показывается рядом с исходным аудио как
черновик для оператора, а не как готовое заполнение полей. Для казахского стоит
посмотреть модели ISSAI Назарбаев Университета, обученные на корпусе KSC2
(около 335 часов, лицензия CC BY 4.0), и подставить их сюда вместо Whisper.
"""

import logging
import threading

from django.conf import settings
from django.db import connection

log = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()


def is_enabled() -> bool:
    return bool(settings.KHABAR_ASR_ENABLED)


def _load_model():
    """Модель грузится один раз на процесс и под замком.

    Без замка два одновременно доехавших аудиовложения подняли бы две копии
    модели и съели вдвое больше памяти.
    """
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel

        log.info(
            "asr: загружаем модель %s (%s, %s)",
            settings.KHABAR_ASR_MODEL,
            settings.KHABAR_ASR_DEVICE,
            settings.KHABAR_ASR_COMPUTE_TYPE,
        )
        _model = WhisperModel(
            settings.KHABAR_ASR_MODEL,
            device=settings.KHABAR_ASR_DEVICE,
            compute_type=settings.KHABAR_ASR_COMPUTE_TYPE,
        )
        return _model


def transcribe(attachment) -> str:
    """Расшифровать принятое аудиовложение. Синхронно, в текущем потоке."""
    if not is_enabled():
        log.info("asr: распознавание выключено, вложение %s", attachment.id)
        return ""

    path = attachment.storage_path
    if not path.exists():
        raise FileNotFoundError(f"нет байтов вложения {attachment.id}")

    # Язык оператор выбирает сам в настройках приложения. Автоопределение на
    # короткой зашумлённой записи с переключением языков ошибается чаще, чем
    # человек, который и так знает, на чём говорит.
    language = attachment.report.language
    model = _load_model()

    segments, info = model.transcribe(
        str(path),
        language=None if language == "auto" else language,
        beam_size=settings.KHABAR_ASR_BEAM_SIZE,
        # Второй заслон против галлюцинаций Whisper на тишине и шуме. Первый
        # стоит на клиенте: он вырезает тишину ещё до попадания в очередь.
        vad_filter=True,
        # Без этого одна галлюцинация тянет за собой следующие: модель
        # продолжает выдуманный текст, опираясь на собственный выдуманный вывод.
        condition_on_previous_text=False,
    )

    text = " ".join(segment.text.strip() for segment in segments).strip()
    log.info(
        "asr: вложение %s, язык %s, длительность %.1f с, символов %d",
        attachment.id,
        getattr(info, "language", language),
        getattr(info, "duration", 0.0),
        len(text),
    )
    return text


def transcribe_in_background(attachment_id):
    """Запустить разбор, не задерживая ответ клиенту.

    Распознавание на процессоре идёт десятки секунд. Держать на это время
    открытым HTTP-соединение с телефоном в поле — ровно то, чего мы избегаем:
    канал узкий и может исчезнуть в любой момент. Клиенту отвечаем сразу,
    расшифровка появляется на панели управления позже.
    """
    thread = threading.Thread(
        target=_run_and_store, args=(attachment_id,), name=f"asr-{attachment_id}", daemon=True
    )
    thread.start()
    return thread


def _run_and_store(attachment_id):
    from .models import Attachment

    try:
        attachment = Attachment.objects.select_related("report").get(pk=attachment_id)
    except Attachment.DoesNotExist:
        return

    if not is_enabled():
        Attachment.objects.filter(pk=attachment_id).update(transcript_status="disabled")
        connection.close()
        return

    Attachment.objects.filter(pk=attachment_id).update(transcript_status="running")
    try:
        text = transcribe(attachment)
    except Exception as error:  # noqa: BLE001 — фоновый поток не должен падать молча
        log.exception("asr: разбор вложения %s не удался", attachment_id)
        Attachment.objects.filter(pk=attachment_id).update(
            transcript_status="failed", transcript=f"ошибка распознавания: {error}"
        )
    else:
        Attachment.objects.filter(pk=attachment_id).update(
            transcript_status="done", transcript=text
        )
    finally:
        # Поток свой, соединение с базой тоже своё — закрываем за собой.
        connection.close()


def extract_fields(transcript: str) -> dict:
    """Разложить расшифровку по полям донесения.

    Не сделано. Заготовка под День 9: тип донесения, количество и приоритет
    вытаскиваются из текста словарём ключевых слов и регулярками на числа,
    после чего предлагаются оператору пункта управления рядом с исходным аудио.
    Модель здесь не нужна и только добавит недетерминированности.
    """
    return {}

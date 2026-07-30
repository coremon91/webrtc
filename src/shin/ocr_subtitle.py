"""Bottom-subtitle OCR for news tickers / lower-thirds."""

from __future__ import annotations

import re
from pathlib import Path

import cv2
import numpy as np
import pytesseract

from shin.models import TimedText


def _normalize_text(text: str) -> str:
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def ocr_bottom_band(
    frame_bgr: np.ndarray,
    *,
    band_ratio: float = 0.22,
    lang: str = "kor+eng",
) -> str:
    """OCR the bottom band of a frame (news subtitle / lower-third region)."""
    h, _w = frame_bgr.shape[:2]
    y0 = int(h * (1.0 - band_ratio))
    band = frame_bgr[y0:, :]
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    config = "--psm 6"
    text = pytesseract.image_to_string(gray, lang=lang, config=config)
    return _normalize_text(text)


def extract_ocr_timeline(
    video_path: str | Path,
    *,
    sample_fps: float = 1.0,
    band_ratio: float = 0.22,
    lang: str = "kor+eng",
    min_text_len: int = 2,
) -> list[TimedText]:
    """Sample frames and build a subtitle-change timeline via OCR."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_interval = max(1, int(round(fps / sample_fps)))
    events: list[TimedText] = []
    last_norm = ""
    start_t = 0.0
    idx = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % frame_interval != 0:
            idx += 1
            continue
        t = idx / fps
        text = ocr_bottom_band(frame, band_ratio=band_ratio, lang=lang)
        norm = re.sub(r"[^0-9A-Za-z가-힣 ]", "", text).lower().strip()
        if len(norm) < min_text_len:
            idx += 1
            continue
        if norm != last_norm:
            if last_norm and events:
                events[-1].end = t
            elif last_norm and not events:
                events.append(TimedText(start=start_t, end=t, text=last_norm, source="ocr"))
            events.append(TimedText(start=t, end=t, text=text, source="ocr"))
            last_norm = norm
            start_t = t
        idx += 1

    duration = idx / fps if idx else 0.0
    cap.release()
    if events:
        events[-1].end = max(events[-1].end, duration)
    return events

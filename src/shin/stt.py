"""Speech-to-text with faster-whisper (open-source Whisper)."""

from __future__ import annotations

from pathlib import Path

from shin.models import TimedText


def transcribe_video(
    video_path: str | Path,
    *,
    model_size: str = "tiny",
    language: str | None = "ko",
    device: str = "cpu",
    compute_type: str = "int8",
) -> list[TimedText]:
    """Return timed STT segments for the video audio track."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    segments, _info = model.transcribe(
        str(video_path),
        language=language,
        vad_filter=True,
        word_timestamps=False,
    )
    out: list[TimedText] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        out.append(
            TimedText(start=float(seg.start), end=float(seg.end), text=text, source="stt")
        )
    return out

"""End-to-end news auto cut-edit pipeline."""

from __future__ import annotations

import json
from pathlib import Path

import cv2

from shin.announcer import extract_announcer_timeline
from shin.cutter import cut_items, write_timeline
from shin.models import EditTimeline
from shin.ocr_subtitle import extract_ocr_timeline
from shin.segmenter import segment_news_items
from shin.stt import transcribe_video


def video_duration(video_path: str | Path) -> float:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    cap.release()
    return float(n / fps) if n else 0.0


def run_pipeline(
    video_path: str | Path,
    output_dir: str | Path,
    *,
    whisper_model: str = "tiny",
    language: str | None = "ko",
    ocr_fps: float = 1.0,
    announcer_fps: float = 0.5,
    upa_steps: int = 8,
    skip_stt: bool = False,
    skip_announcer: bool = False,
    skip_cut: bool = False,
) -> EditTimeline:
    video_path = Path(video_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = video_duration(video_path)
    ocr_events = extract_ocr_timeline(video_path, sample_fps=ocr_fps)
    stt_segments = [] if skip_stt else transcribe_video(
        video_path, model_size=whisper_model, language=language
    )
    announcer_events = (
        []
        if skip_announcer
        else extract_announcer_timeline(
            video_path, sample_fps=announcer_fps, upa_steps=upa_steps
        )
    )
    items = segment_news_items(duration, ocr_events, stt_segments, announcer_events)
    timeline = EditTimeline(
        video_path=str(video_path),
        duration=duration,
        items=items,
        ocr_events=ocr_events,
        stt_segments=stt_segments,
        announcer_events=announcer_events,
    )
    write_timeline(timeline, output_dir / "timeline.json")
    (output_dir / "summary.txt").write_text(
        "\n".join(
            f"[{it.index:02d}] {it.start:6.2f}-{it.end:6.2f}s  "
            f"{'ANN ' if it.has_announcer else '    '}"
            f"{it.title}"
            for it in items
        )
        + "\n",
        encoding="utf-8",
    )
    if not skip_cut and items:
        clips_dir = output_dir / "clips"
        if clips_dir.exists():
            for old in clips_dir.glob("item_*.mp4"):
                old.unlink()
        cut_items(video_path, items, clips_dir)
    (output_dir / "timeline.json").write_text(
        json.dumps(timeline.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return timeline

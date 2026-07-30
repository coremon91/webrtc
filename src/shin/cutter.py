"""Cut video into per-item clips with ffmpeg."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from shin.models import EditTimeline, NewsItem


def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr}"
        )


def cut_items(
    video_path: str | Path,
    items: list[NewsItem],
    output_dir: str | Path,
    *,
    copy_codecs: bool = False,
) -> list[Path]:
    """Export one mp4 per news item. Re-encodes by default for accurate cuts."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for item in items:
        out = output_dir / f"item_{item.index:02d}.mp4"
        duration = max(0.1, item.end - item.start)
        if copy_codecs:
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{item.start:.3f}",
                "-i",
                str(video_path),
                "-t",
                f"{duration:.3f}",
                "-c",
                "copy",
                str(out),
            ]
        else:
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{item.start:.3f}",
                "-i",
                str(video_path),
                "-t",
                f"{duration:.3f}",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(out),
            ]
        _run(cmd)
        paths.append(out)
    return paths


def write_timeline(timeline: EditTimeline, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(timeline.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return path

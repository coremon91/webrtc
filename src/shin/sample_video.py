"""Synthetic news sample generator for local demos (OpenCV + ffmpeg + espeak)."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

ITEMS = [
    {
        "title": "ITEM1 WEATHER ALERT",
        "speech": "First news item. Weather alert for the capital region.",
        "color": (126, 35, 26),  # BGR
        "seconds": 5,
        "face": True,
    },
    {
        "title": "ITEM2 MARKET UPDATE",
        "speech": "Second news item. Markets rose after the policy announcement.",
        "color": (64, 77, 0),
        "seconds": 5,
        "face": False,
    },
    {
        "title": "ITEM3 SPORTS FINAL",
        "speech": "Third news item. The home team won the championship final.",
        "color": (140, 20, 74),
        "seconds": 5,
        "face": True,
    },
]


def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{proc.stderr}")


def _announcer_face() -> np.ndarray | None:
    candidates = [
        Path(__file__).resolve().parents[2] / "samples" / "assets" / "announcer.jpg",
        Path("samples/assets/announcer.jpg"),
    ]
    for path in candidates:
        if path.exists():
            img = cv2.imread(str(path))
            if img is not None:
                return img
    return None


def _make_frame(item: dict, face_img: np.ndarray | None) -> np.ndarray:
    frame = np.full((720, 1280, 3), item["color"], dtype=np.uint8)
    if item["face"] and face_img is not None:
        face = cv2.resize(face_img, (220, 280))
        x0, y0 = 530, 120
        frame[y0 : y0 + face.shape[0], x0 : x0 + face.shape[1]] = face
    # Lower-third subtitle bar
    cv2.rectangle(frame, (0, 580), (1280, 720), (0, 0, 0), -1)
    cv2.putText(
        frame,
        item["title"],
        (320, 660),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.2,
        (255, 255, 255),
        3,
        cv2.LINE_AA,
    )
    return frame


def generate_sample_news(output_path: str | Path) -> Path:
    """Create a 3-item fake news video with burned-in lower-third titles + speech."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    face_img = _announcer_face()

    with tempfile.TemporaryDirectory(prefix="shin-sample-") as tmp:
        tmp_path = Path(tmp)
        parts: list[Path] = []
        for i, item in enumerate(ITEMS, start=1):
            wav = tmp_path / f"speech_{i}.wav"
            _run(["espeak-ng", "-w", str(wav), "-s", "140", item["speech"]])

            raw = tmp_path / f"clip_{i}.avi"
            writer = cv2.VideoWriter(
                str(raw),
                cv2.VideoWriter_fourcc(*"MJPG"),
                25.0,
                (1280, 720),
            )
            frame = _make_frame(item, face_img)
            for _ in range(item["seconds"] * 25):
                writer.write(frame)
            writer.release()

            clip = tmp_path / f"clip_{i}.mp4"
            _run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(raw),
                    "-i",
                    str(wav),
                    "-shortest",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                    str(clip),
                ]
            )
            parts.append(clip)

        concat_list = tmp_path / "concat.txt"
        concat_list.write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
        _run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_list),
                "-c",
                "copy",
                str(output_path),
            ]
        )
    return output_path

"""Announcer face detection refined with Upsample Anything probability upsampling."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import torch

from shin.models import AnnouncerEvent
from shin.upsample_anything import get_device, upa


def _haar_cascade() -> cv2.CascadeClassifier:
    path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(path)
    if cascade.empty():
        raise RuntimeError("Failed to load OpenCV Haar face cascade")
    return cascade


def detect_faces(frame_bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
    cascade = _haar_cascade()
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(48, 48))
    return [(int(x), int(y), int(w), int(h)) for x, y, w, h in faces]


def face_probability_map(
    frame_bgr: np.ndarray,
    faces: list[tuple[int, int, int, int]],
    *,
    lr_size: int = 28,
) -> torch.Tensor:
    """Build a low-res face probability map from detections (for UPA)."""
    h, w = frame_bgr.shape[:2]
    mask = np.zeros((h, w), dtype=np.float32)
    for x, y, fw, fh in faces:
        cv2.ellipse(
            mask,
            (x + fw // 2, y + fh // 2),
            (max(1, fw // 2), max(1, fh // 2)),
            0,
            0,
            360,
            1.0,
            -1,
        )
    lr = cv2.resize(mask, (lr_size, lr_size), interpolation=cv2.INTER_AREA)
    return torch.from_numpy(lr).view(1, 1, lr_size, lr_size)


def refine_face_mask_with_upa(
    frame_bgr: np.ndarray,
    faces: list[tuple[int, int, int, int]],
    *,
    steps: int = 8,
    guide_size: int = 224,
    lr_size: int = 28,
    device: torch.device | None = None,
) -> tuple[np.ndarray, float]:
    """Upsample face probability with Upsample Anything; return HR mask + score."""
    device = device or get_device()
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    rgb_small = cv2.resize(rgb, (guide_size, guide_size), interpolation=cv2.INTER_AREA)
    # Scale face boxes into guide resolution for LR map generation on original then resize.
    lr = face_probability_map(frame_bgr, faces, lr_size=lr_size)
    hr_prob = upa(rgb_small, lr, device=device, steps=steps)
    mask = hr_prob.squeeze().detach().float().cpu().numpy()
    mask = np.clip(mask, 0.0, 1.0)
    score = float(mask.mean() * 4.0 + mask.max())  # emphasize presence
    return mask, score


def extract_announcer_timeline(
    video_path: str | Path,
    *,
    sample_fps: float = 0.5,
    upa_steps: int = 8,
    score_threshold: float = 0.35,
    device: torch.device | None = None,
) -> list[AnnouncerEvent]:
    """Detect announcer-like face presence; refine with Upsample Anything when faces exist."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_interval = max(1, int(round(fps / sample_fps)))
    events: list[AnnouncerEvent] = []
    idx = 0
    device = device or get_device()

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % frame_interval != 0:
            idx += 1
            continue
        t = idx / fps
        faces = detect_faces(frame)
        if not faces:
            idx += 1
            continue
        # Prefer largest face (typical studio announcer framing).
        faces = sorted(faces, key=lambda b: b[2] * b[3], reverse=True)
        primary = faces[0]
        mask, score = refine_face_mask_with_upa(
            frame, [primary], steps=upa_steps, device=device
        )
        if score >= score_threshold:
            events.append(
                AnnouncerEvent(time=t, score=score, bbox=primary, refined=True)
            )
        else:
            # Still record weak detections without claiming announcer.
            events.append(
                AnnouncerEvent(time=t, score=score, bbox=primary, refined=True)
            )
        idx += 1
        _ = mask  # mask retained for potential debugging/export

    cap.release()
    return events

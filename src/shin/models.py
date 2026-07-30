from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class TimedText:
    start: float
    end: float
    text: str
    source: str = "unknown"  # ocr | stt

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AnnouncerEvent:
    time: float
    score: float
    bbox: tuple[int, int, int, int] | None = None
    refined: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        if self.bbox is not None:
            d["bbox"] = list(self.bbox)
        return d


@dataclass
class NewsItem:
    index: int
    start: float
    end: float
    title: str
    ocr_text: str = ""
    stt_text: str = ""
    has_announcer: bool = False
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EditTimeline:
    video_path: str
    duration: float
    items: list[NewsItem]
    ocr_events: list[TimedText] = field(default_factory=list)
    stt_segments: list[TimedText] = field(default_factory=list)
    announcer_events: list[AnnouncerEvent] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "video_path": self.video_path,
            "duration": self.duration,
            "items": [i.to_dict() for i in self.items],
            "ocr_events": [e.to_dict() for e in self.ocr_events],
            "stt_segments": [s.to_dict() for s in self.stt_segments],
            "announcer_events": [a.to_dict() for a in self.announcer_events],
        }

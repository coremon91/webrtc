"""Merge OCR + STT + announcer signals into per-item news segments."""

from __future__ import annotations

from shin.models import AnnouncerEvent, NewsItem, TimedText


def _nearest_announcer(t: float, events: list[AnnouncerEvent], window: float = 2.5) -> bool:
    return any(abs(e.time - t) <= window and e.score >= 0.35 for e in events)


def _stt_covering(start: float, end: float, stt: list[TimedText]) -> str:
    parts = [s.text for s in stt if s.end >= start and s.start <= end]
    return " ".join(parts).strip()


def _ocr_text_at(t: float, ocr_events: list[TimedText]) -> str:
    """Pick the OCR subtitle active at time t (half-open [start, end))."""
    for e in ocr_events:
        if e.start <= t < e.end:
            return e.text
    # Fallback: nearest preceding event.
    prev = [e for e in ocr_events if e.start <= t]
    if prev:
        return prev[-1].text
    return ""


def _stt_gap_boundaries(stt: list[TimedText], min_gap: float = 1.2) -> list[float]:
    cuts: list[float] = []
    for i, seg in enumerate(stt):
        if i == 0:
            continue
        gap = seg.start - stt[i - 1].end
        if gap >= min_gap:
            cuts.append(float(seg.start))
    return cuts


def segment_news_items(
    duration: float,
    ocr_events: list[TimedText],
    stt_segments: list[TimedText],
    announcer_events: list[AnnouncerEvent],
    *,
    min_item_sec: float = 2.0,
) -> list[NewsItem]:
    """Build item cuts primarily from OCR subtitle changes, refined by STT gaps.

    Rules:
    - Bottom-subtitle OCR text changes define item boundaries
    - STT silence gaps refine boundaries when OCR is sparse
    - Announcer face (UPA-refined) marks intros near item starts; does not split items alone
    """
    if duration <= 0:
        return []

    boundaries = {0.0, duration}

    # Primary: OCR subtitle changes.
    for e in ocr_events:
        boundaries.add(float(e.start))

    # Secondary: STT gaps only when they are not already near an OCR cut.
    ocr_cuts = [float(e.start) for e in ocr_events]
    for cut in _stt_gap_boundaries(stt_segments):
        if all(abs(cut - o) > min_item_sec for o in ocr_cuts):
            boundaries.add(cut)

    cuts = sorted(b for b in boundaries if 0.0 <= b <= duration + 1e-6)
    if cuts[-1] < duration:
        cuts.append(duration)

    # Merge cuts that are too close; prefer keeping OCR starts.
    ocr_starts = {round(e.start, 2) for e in ocr_events}
    merged = [cuts[0]]
    for c in cuts[1:]:
        if c - merged[-1] < min_item_sec and round(c, 2) not in ocr_starts:
            continue
        if c - merged[-1] < 0.4:
            # Extremely close: replace previous if new is OCR, else skip.
            if round(c, 2) in ocr_starts:
                merged[-1] = c
            continue
        merged.append(c)
    if merged[-1] < duration - 0.05:
        merged.append(duration)
    else:
        merged[-1] = duration

    items: list[NewsItem] = []
    for i in range(len(merged) - 1):
        start, end = merged[i], merged[i + 1]
        if end - start < 0.4:
            continue
        ocr_text = _ocr_text_at(start + 0.05, ocr_events)
        stt_text = _stt_covering(start, end, stt_segments)
        has_ann = _nearest_announcer(start, announcer_events)
        near_ocr = any(abs(e.start - start) < 0.6 for e in ocr_events)
        reasons = ["ocr_boundary" if near_ocr else "timeline"]
        if has_ann:
            reasons.append("announcer_upa")
        if stt_text:
            reasons.append("stt_span")
        short_stt = stt_text[:40] + ("…" if len(stt_text) > 40 else "")
        title = ocr_text or short_stt or f"Item {i + 1}"
        items.append(
            NewsItem(
                index=i + 1,
                start=start,
                end=end,
                title=title,
                ocr_text=ocr_text,
                stt_text=stt_text,
                has_announcer=has_ann,
                reasons=reasons,
            )
        )

    for i, item in enumerate(items, start=1):
        item.index = i
    return items

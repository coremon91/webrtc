import numpy as np
import torch

from shin.models import AnnouncerEvent, TimedText
from shin.segmenter import segment_news_items
from shin.upsample_anything import get_device, upa


def test_segment_news_items_uses_ocr_boundaries():
    ocr = [
        TimedText(0.0, 5.0, "ITEM1 WEATHER ALERT", "ocr"),
        TimedText(5.0, 10.0, "ITEM2 MARKET UPDATE", "ocr"),
        TimedText(10.0, 15.0, "ITEM3 SPORTS FINAL", "ocr"),
    ]
    stt = [
        TimedText(0.2, 4.5, "weather alert", "stt"),
        TimedText(5.2, 9.5, "markets rose", "stt"),
        TimedText(10.2, 14.5, "championship final", "stt"),
    ]
    ann = [AnnouncerEvent(time=0.5, score=0.9, bbox=(1, 2, 3, 4), refined=True)]
    items = segment_news_items(15.0, ocr, stt, ann, min_item_sec=2.0)
    assert len(items) >= 3
    assert items[0].start == 0.0
    assert "WEATHER" in items[0].title or "weather" in items[0].stt_text.lower()
    assert items[0].has_announcer is True


def test_upa_cpu_probability_upsample():
    device = get_device("cpu")
    hr = np.random.randint(0, 255, (112, 112, 3), dtype=np.uint8)
    lr = torch.rand(1, 1, 7, 7)
    out = upa(hr, lr, device=device, steps=2)
    assert out.shape[-2:] == (112, 112)
    assert out.shape[1] == 1

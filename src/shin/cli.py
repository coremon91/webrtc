"""CLI for Shin news auto cut-editor."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="shin",
        description="Auto cut-edit news videos using OCR, STT, and Upsample Anything",
    )
    sub = p.add_subparsers(dest="command", required=True)

    cut = sub.add_parser("cut", help="Analyze a news video and export per-item clips")
    cut.add_argument("video", type=Path, help="Input news video path")
    cut.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("output"),
        help="Output directory (timeline + clips)",
    )
    cut.add_argument("--whisper-model", default="tiny", help="faster-whisper model size")
    cut.add_argument("--language", default="ko", help="STT language code (or 'auto')")
    cut.add_argument("--ocr-fps", type=float, default=1.0)
    cut.add_argument("--announcer-fps", type=float, default=0.5)
    cut.add_argument("--upa-steps", type=int, default=8, help="Upsample Anything TTO steps")
    cut.add_argument("--skip-stt", action="store_true")
    cut.add_argument("--skip-announcer", action="store_true")
    cut.add_argument("--skip-cut", action="store_true", help="Only write timeline JSON")

    sample = sub.add_parser("make-sample", help="Generate a synthetic 3-item news sample video")
    sample.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("samples/sample_news.mp4"),
        help="Output sample video path",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "make-sample":
        from shin.sample_video import generate_sample_news

        path = generate_sample_news(args.output)
        print(f"Wrote sample news video: {path}")
        return 0

    if args.command == "cut":
        from shin.pipeline import run_pipeline

        lang = None if args.language == "auto" else args.language
        timeline = run_pipeline(
            args.video,
            args.output,
            whisper_model=args.whisper_model,
            language=lang,
            ocr_fps=args.ocr_fps,
            announcer_fps=args.announcer_fps,
            upa_steps=args.upa_steps,
            skip_stt=args.skip_stt,
            skip_announcer=args.skip_announcer,
            skip_cut=args.skip_cut,
        )
        print(json.dumps({"items": len(timeline.items), "duration": timeline.duration}, indent=2))
        for it in timeline.items:
            print(
                f"  [{it.index:02d}] {it.start:6.2f}-{it.end:6.2f}s "
                f"{'ANN' if it.has_announcer else '   '} {it.title}"
            )
        print(f"Output: {args.output}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())

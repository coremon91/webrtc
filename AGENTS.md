# Agent notes

## Cursor Cloud specific instructions

Shin is a Python CLI that auto cut-edits news videos using OCR (Tesseract), STT (faster-whisper), and Upsample Anything (KAIST, vendored CPU/CUDA-aware port under `src/shin/upsample_anything.py`).

### Commands

- Install: `pip install -r requirements.txt && pip install -e .` (CPU torch: install from `https://download.pytorch.org/whl/cpu` first)
- Sample video: `shin make-sample -o samples/sample_news.mp4` (needs `espeak-ng` + `ffmpeg`)
- Run editor: `shin cut <video> -o output/demo`
- Lint: `ruff check src tests`
- Tests: `pytest`

### Caveats

- System packages required outside pip: `ffmpeg`, `tesseract-ocr`, `tesseract-ocr-kor`, `tesseract-ocr-eng`, and `espeak-ng` for sample generation.
- Default Whisper model is `tiny` for fast CPU demos; first STT run downloads model weights.
- Upsample Anything TTO is expensive on CPU — keep `--upa-steps` low (default 8) unless a GPU is available.
- Prefer `shin cut ...` over inventing ad-hoc ffmpeg scripts; timeline JSON is the source of truth for cuts.

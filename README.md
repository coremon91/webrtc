# Shin — News Auto Cut Editor

OCR + STT + [Upsample Anything](https://github.com/seominseok0429/Upsample-Anything_Pytorch) (KAIST)으로
뉴스 영상을 **아이템 단위 자동 컷편집**합니다. 사용 기술은 모두 무료 오픈소스입니다.

## Pipeline

1. **OCR** — 하단 자막/로어서드 텍스트 변화를 감지해 아이템 경계 후보 생성 (Tesseract)
2. **STT** — 음성 구간·공백을 분석해 경계를 보정 (faster-whisper)
3. **Upsample Anything** — 아나운서 얼굴 확률맵을 고해상도로 업샘플해 인트로 컷 정밀화
4. **Cut** — ffmpeg로 아이템별 클립 + `timeline.json` 출력

## Requirements

- Python 3.10+
- `ffmpeg`
- `tesseract-ocr` (+ `tesseract-ocr-kor`, `tesseract-ocr-eng`)
- (샘플 생성 시) `espeak-ng`

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
```

CPU-only PyTorch:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
pip install -e .
```

## Usage

```bash
# 합성 3-아이템 뉴스 샘플 생성
shin make-sample -o samples/sample_news.mp4

# 자동 컷편집
shin cut samples/sample_news.mp4 -o output/demo

# STT만 건너뛰기 / 타임라인만 생성
shin cut samples/sample_news.mp4 -o output/demo --skip-stt
shin cut samples/sample_news.mp4 -o output/demo --skip-cut
```

출력:

- `output/demo/timeline.json` — OCR/STT/아나운서/아이템 메타데이터
- `output/demo/summary.txt` — 짧은 요약
- `output/demo/clips/item_XX.mp4` — 아이템별 클립

## Tests / Lint

```bash
pytest
ruff check src tests
```

## Notes

- Upsample Anything 공식 구현은 CUDA `.cuda()` 호출이 하드코딩되어 있어, 이 저장소에는 **device-aware 포팅** (`src/shin/upsample_anything.py`)을 포함합니다.
- 원 논문/코드: [Upsample Anything (PyTorch)](https://github.com/seominseok0429/Upsample-Anything_Pytorch)

# SafeView Backend

Shared FastAPI AI server for the browser extension and Android app. Runs on `http://localhost:8000` during development.

## Prerequisites

- Python 3.10 or newer
- Team model weights: `dino_v3_linear.pth` (provided by the project team)
- Violence weights: `violence.pt` (Ultralytics YOLO, placed under `backend/models/`)
- System `ffmpeg` on `PATH` for pydub/Whisper WebM-to-WAV conversion

## Setup (virtual environment)

All dependencies are installed inside a project-local venv. From the `backend/` directory:

```powershell
# Windows (PowerShell)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

```bash
# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

## Place the model file

Copy the team weights into this exact path (filename must match):

```
backend/
└── models/
    ├── dino_v3_linear.pth
    └── violence.pt
```

If the file is missing, the server still starts but nudity requests **fail open** (`detected: false`, `model_loaded: false` in responses).
If `violence.pt` is missing, violence requests also **fail open** and `/health` reports `models.violence.loaded: false`.

## Audio profanity prerequisites

`openai-whisper` and `pydub` are installed from `requirements.txt`. Whisper uses ffmpeg through pydub to decode browser `audio/webm` chunks, so install ffmpeg separately and confirm it is available on `PATH`:

```powershell
ffmpeg -version
```

The backend loads profanity terms from `backend/data/blacklist_en.json` and `backend/data/blacklist_am.json`. Detection logs only boolean status and transcript length; it does not log matched profanity words.

## Run the server

With the venv activated:

```powershell
# Windows
.\.venv\Scripts\Activate.ps1
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

```bash
# macOS / Linux
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Verify:

```text
GET  http://localhost:8000/health
POST http://localhost:8000/analyze-image
POST http://localhost:8000/analyze-audio
```

Interactive docs: `http://localhost:8000/docs`

## Run tests

```powershell
.\.venv\Scripts\Activate.ps1
pytest tests/ -v
```

Tests cover:

- `GET /health` response shape
- `POST /analyze-image` with a blank JPEG
- UI sensitivity is used directly as the detection threshold
- `POST /analyze-image` with `category=violence` and `category=all`
- `POST /analyze-audio` fail-open behavior for silent chunks

## API quick reference

### `GET /health`

```json
{
  "status": "ok",
  "backend": "running",
  "models": {
    "nudity": { "loaded": true },
    "violence": { "loaded": true }
  },
  "model": "dino_v3_linear",
  "model_loaded": true,
  "whisper_loaded": true
}
```

### `POST /analyze-image`

Multipart form fields:

| Field         | Type   | Description                                      |
|---------------|--------|--------------------------------------------------|
| `frame`       | file   | JPEG image bytes                                 |
| `sensitivity` | float  | 0.0–1.0 detection threshold from the UI          |
| `category`    | string | `nudity`, `violence`, `all` |

Example response:

```json
{
  "category": "nudity",
  "detected": false,
  "confidence": 0.43,
  "action": "ALLOW",
  "model_loaded": true
}
```

### `POST /analyze-audio`

Multipart form fields:

| Field          | Type   | Description                                      |
|----------------|--------|--------------------------------------------------|
| `audio_chunk`  | file   | WebM/Opus audio bytes (MediaRecorder)            |
| `language`     | string | `en` or `am`                                     |
| `sensitivity`  | float  | 0.0–1.0 (accepted; not used for profanity)       |

Example response:

```json
{
  "detected": true,
  "action": "MUTE",
  "duration_ms": 3500,
  "whisper_loaded": true
}
```

If Whisper failed to load at startup or ffmpeg cannot decode the WebM chunk, `whisper_loaded` is `false` or detection fails open with `detected: false`.

## Clients

| Client              | Backend URL (dev)              |
|---------------------|--------------------------------|
| Chrome extension    | `http://localhost:8000`        |
| Android emulator    | `http://10.0.2.2:8000`         |
| Android device      | `http://<your-pc-lan-ip>:8000` |

CORS allows `chrome-extension://*`, `http://localhost:*`, and `http://10.0.2.2:*`.

## Optional: TMDb metadata stub

See `metadata.py` for activating `TMDB_API_KEY` when real metadata lookup is implemented.

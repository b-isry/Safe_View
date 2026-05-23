# SafeView Backend

Shared FastAPI AI server for the browser extension and Android app. Runs on `http://localhost:8000` during development.

## Prerequisites

- Python 3.10 or newer
- Team model weights: `dino_v3_linear.pth` (provided by the project team)

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
    └── dino_v3_linear.pth
```

If the file is missing, the server still starts but nudity requests **fail open** (`detected: false`, `model_loaded: false` in responses).

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
- BR-01 confidence floor (`max(0.75, sensitivity)`)
- Stub categories always return `detected: false`

## API quick reference

### `GET /health`

```json
{
  "status": "ok",
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
| `sensitivity` | float  | 0.0–1.0 (BR-01 floor: effective ≥ 0.75)          |
| `category`    | string | `nudity`, `violence`, `kissing`, `profanity`, `lgbtq` |

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
  "duration_ms": 1500,
  "whisper_loaded": true
}
```

`duration_ms` is always `1500` (BR-05). If Whisper failed to load at startup, `whisper_loaded` is `false` and `detected` is `false`.

## Clients

| Client              | Backend URL (dev)              |
|---------------------|--------------------------------|
| Chrome extension    | `http://localhost:8000`        |
| Android emulator    | `http://10.0.2.2:8000`         |
| Android device      | `http://<your-pc-lan-ip>:8000` |

CORS allows `chrome-extension://*`, `http://localhost:*`, and `http://10.0.2.2:*`.

## Optional: TMDb metadata stub

See `metadata.py` for activating `TMDB_API_KEY` when real metadata lookup is implemented.

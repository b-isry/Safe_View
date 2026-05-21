# SafeView

**SafeView** is a real-time, AI-powered content moderation system developed as a Software Engineering capstone at Bahir Dar University (Bahir Dar Institute of Technology, Faculty of Computing).

Two client applications share one **local FastAPI** backend:

| Deliverable | Platform | Behavior |
|-------------|----------|----------|
| **Browser extension** | Chrome / Chromium (MV3) | Finds `<video>` on any page, samples frames, blurs the **entire video** when restricted content is detected |
| **Android app** | Android 10+ (Flutter) | **In-app browser** (WebView blur) and **system-wide screen overlay** (MediaProjection + full-screen layer) |

Inference runs **only** against a user-configured backend on the LAN or localhost — no cloud AI, no frame storage on disk.

**Authors:** Blen Bizuayehu, Lidiya Getale, Bisrat Teshome

---

## Repository layout

```
SafeView/
├── backend/          # FastAPI + PyTorch (dino_v3_linear.pth)
├── extension/        # Chrome MV3 extension (TypeScript / Vite)
├── android/          # Flutter Android app
└── README.md         # This file
```

Authoritative build rules and API contracts: [`.cursorrules`](.cursorrules) (overrides RAD/RDD where they differ).

---

## Prerequisites

Install these before running any component:

| Tool | Version | Used for |
|------|---------|----------|
| **Python** | 3.10 or newer | AI backend |
| **Node.js** | 18 LTS or newer (20+ recommended) | Extension build (Vite 5) |
| **npm** | 9+ (bundled with Node) | Extension dependencies |
| **Flutter** | 3.10+ stable (3.41+ tested) | Android app |
| **Dart** | 3.10+ (bundled with Flutter) | Android app |
| **Android SDK** | API **29+** (Android 10); compile SDK via Flutter | Android builds |
| **JDK** | **17** | Android Gradle builds |
| **Chrome** | Recent Chromium | Unpacked extension |

Optional but recommended:

- **Android Studio** or VS Code with Flutter/Android extensions
- **CUDA-capable GPU** — speeds up PyTorch inference; CPU works
- Physical **Android device** or emulator (API 29+) for the mobile app

Verify installations:

```bash
python --version    # 3.10+
node --version      # v18+
flutter --version   # 3.10+
flutter doctor      # Android toolchain OK
```

---

## 1. Backend setup

### 1.1 Virtual environment and dependencies

```powershell
# Windows (PowerShell) — from repo root
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

```bash
# macOS / Linux
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### 1.2 Model file placement

Place the team-provided weights at **exactly** this path (do not rename):

```
backend/models/dino_v3_linear.pth
```

- The server loads this file **once** at startup.
- If the file is missing, the server still starts but nudity detection **fails open** (`detected: false`, `model_loaded: false`).
- Do not retrain or replace the architecture — only load and run inference.

### 1.3 Run the server

Bind on all interfaces so emulators and phones on the same network can reach the PC:

```powershell
# Windows (venv activated)
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

```bash
# macOS / Linux
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Verify:

```text
GET  http://localhost:8000/health
POST http://localhost:8000/analyze-image
```

Interactive API docs: `http://localhost:8000/docs`

### 1.4 Backend tests

```bash
cd backend
pytest tests/ -v
```

More detail: [`backend/README.md`](backend/README.md)

---

## 2. Browser extension — build and load

### 2.1 Build

```powershell
cd extension
npm install

# IBM Plex Sans (bundled locally — required for popup/options UI)
New-Item -ItemType Directory -Force -Path src\popup\fonts | Out-Null
Copy-Item node_modules\@fontsource\ibm-plex-sans\files\ibm-plex-sans-latin-400-normal.woff2 src\popup\fonts\
Copy-Item node_modules\@fontsource\ibm-plex-sans\files\ibm-plex-sans-latin-600-normal.woff2 src\popup\fonts\

npm run build
```

`npm run build` compiles TypeScript with **Vite** into `extension/dist/`. The manifest references `dist/` for the service worker, content script, popup, and options pages.

### 2.2 Load unpacked in Chrome

1. Ensure the backend is running at `http://localhost:8000`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the **`extension/`** folder (the directory that contains `manifest.json`, not `dist/` alone).

After code changes: run `npm run build` again, then click **Reload** on the extension card.

### 2.3 Extension configuration

- Open the extension **popup** — toggle protection, check backend status.
- Open **Options** — category filters, sensitivity (Low / Medium / High), backend URL (default `http://localhost:8000`), profanity list, **Test Connection**.

### 2.4 Extension tests

```bash
cd extension
npm test
```

More detail: [`extension/README.md`](extension/README.md)

---

## 3. Android app — build and backend connection

### 3.1 Setup

```bash
cd android
flutter pub get
```

Requirements: **minSdk 29** (Android 10), cleartext HTTP enabled for local backend URLs during development.

### 3.2 Run on emulator or device

```bash
flutter run
```

Grant when prompted:

- **Display over other apps** — required for screen overlay mode  
- **Screen capture** — MediaProjection consent when starting overlay  
- **Notifications** — foreground overlay service (Android 13+)

### 3.3 Connect to the backend

The FastAPI server must be reachable from the app. Use the URL in **Settings → Backend URL → Test Connection**.

| Environment | Backend URL | Notes |
|-------------|-------------|--------|
| **Android emulator** | `http://10.0.2.2:8000` | Default; `10.0.2.2` is the host machine loopback from the emulator |
| **Physical device** | `http://<YOUR_PC_LAN_IP>:8000` | Example: `http://192.168.1.42:8000` |

**Physical device checklist:**

1. Start backend with `--host 0.0.0.0 --port 8000` on your PC.
2. Find your PC’s LAN IP (`ipconfig` on Windows, `ip addr` on Linux).
3. Phone and PC on the **same Wi‑Fi** network.
4. Allow **port 8000** through Windows Firewall (or OS firewall) for private networks.
5. In the app: **Settings → Backend URL** → enter `http://<PC_IP>:8000` → **Test Connection** (should show reachable).

**Emulator checklist:**

1. Backend running on the host.
2. Default URL `http://10.0.2.2:8000` usually works without changes.
3. If not, confirm the server is bound to `0.0.0.0`, not only `127.0.0.1`.

### 3.4 Using the app

| Mode | How to use |
|------|------------|
| **Browser** | Dashboard → **Browser** → turn **Protection ON** → **Open Browser** → browse video sites |
| **Overlay** | Dashboard → **Overlay** → grant permissions in Settings → **Start Overlay** → use other apps (YouTube, TikTok, etc.) |

Live detection and service events appear in the dashboard **Live status** feed (EventChannel).

### 3.5 Android tests

```bash
cd android
flutter test
```

More detail: [`android/README.md`](android/README.md)

---

## End-to-end dev workflow

1. Start **backend** (`uvicorn` on port 8000, model file in place).
2. **Extension:** `npm run build` → load unpacked → enable protection → visit a page with `<video>`.
3. **Android:** `flutter run` → set backend URL → Test Connection → enable protection → Browser or Overlay mode.

Default sensitivity uses a **0.75 confidence floor** (BR-01): effective threshold = `max(0.75, userSensitivity)`.

---

## API quick reference (shared by all clients)

### `GET /health`

```json
{
  "status": "ok",
  "model": "dino_v3_linear",
  "model_loaded": true
}
```

### `POST /analyze-image`

Multipart form-data:

| Field | Type | Description |
|-------|------|-------------|
| `frame` | JPEG file | Video/screen frame |
| `sensitivity` | float | 0.0–1.0 from user settings |
| `category` | string | `nudity`, `violence`, `kissing`, `profanity`, `lgbtq` |

Example response:

```json
{
  "category": "nudity",
  "detected": true,
  "confidence": 0.87,
  "action": "BLUR",
  "model_loaded": true
}
```

---

## Known limitations

- **Nudity only (real model):** `dino_v3_linear.pth` powers nudity detection. Violence, kissing, profanity, and LGBTQ+ categories are **stubs** that always return no detection until real models are added.
- **Full-screen blur only:** No coordinate-based or “surgical” masking — entire `<video>` (extension), WebView overlay (browser mode), or full-screen layer (Android overlay).
- **Local backend only:** No cloud inference; clients must reach your machine on the LAN or localhost. No offline/on-device model in the extension or app.
- **Chrome desktop only:** MV3 extension targets Chromium desktop; no Firefox/Safari, no iOS.
- **Android only:** No iOS app; Flutter project is Android-only.
- **Frame rate cap:** ≤ 2 FPS (500 ms minimum between samples) on all platforms.
- **Privacy scope:** Frames stay in RAM for inference only; never written to disk or sent to third-party APIs. If the backend is down, clients **fail open** (no blur).
- **Overlay mode constraints:** Requires display-over-other-apps permission, MediaProjection consent, and a foreground service notification; some apps or DRM content may block capture or blur effectiveness.
- **TMDb metadata:** Stub only — always allows until an API key is configured.
- **Development networking:** Android uses cleartext HTTP to local IPs; production would need HTTPS and proper network security configuration.
- **Model dependency:** Large PyTorch + transformers stack; first startup may be slow while weights load.

---

## License and academic use

This repository is a capstone project for educational use. Model weights (`dino_v3_linear.pth`) are provided separately by the project team — do not redistribute without team approval.

For module-specific notes, see:

- [`backend/README.md`](backend/README.md)
- [`extension/README.md`](extension/README.md)
- [`android/README.md`](android/README.md)

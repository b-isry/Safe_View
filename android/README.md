# SafeView — Android (Flutter)

Android-only Flutter client for SafeView: in-app browser with WebView blur and system-wide screen overlay via MediaProjection.

## Prerequisites

- Flutter 3.10+ (stable)
- Android SDK with API 29+ device or emulator
- FastAPI backend running on the host (see `../backend/README.md`)

## Setup

```bash
cd android
flutter pub get
```

Default backend URL for emulator: `http://10.0.2.2:8000`. On a physical device, set your PC's LAN IP in **Settings → Backend URL**.

## Run

```bash
flutter run
```

## Project layout

- `lib/` — Dart UI, services, widgets
- `android/app/src/main/kotlin/com/safeview/safeview/` — `MainActivity`, `OverlayService`, capture helpers
- `android/app/src/main/AndroidManifest.xml` — permissions and `OverlayService` (`foregroundServiceType="mediaProjection"`)

## Tests

```bash
flutter test
```

Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome — Bahir Dar Institute of Technology, 2018 EC.

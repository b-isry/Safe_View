# SafeView Browser Extension (Chrome MV3)

## Setup

```powershell
cd extension
npm install
# Copy IBM Plex Sans woff2 into src/popup/fonts (first-time / after clean clone)
New-Item -ItemType Directory -Force -Path src\popup\fonts | Out-Null
Copy-Item node_modules\@fontsource\ibm-plex-sans\files\ibm-plex-sans-latin-400-normal.woff2 src\popup\fonts\
Copy-Item node_modules\@fontsource\ibm-plex-sans\files\ibm-plex-sans-latin-600-normal.woff2 src\popup\fonts\
npm run build
```

## Load unpacked in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder (the directory that contains `manifest.json`)

Re-run `npm run build` after TypeScript changes before reloading the extension.

## Project layout

See the master prompt (`/.cursorrules`) for the full `src/` structure: content scripts, service worker, popup, and options.

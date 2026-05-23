// SafeView — vite.config.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Bundle MV3 service worker, content scripts, popup, options, and offscreen into dist/.
//
// Two-pass build (see package.json "build"):
//   1. Default mode — ES modules for service worker, popup, options, offscreen.
//   2. --mode contentIife — single IIFE for the content script (no manifest type: module).

import { resolve } from "path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const rootDir = resolve(__dirname);

const staticCopyTargets = [
  { src: "src/popup/index.html", dest: "popup" },
  { src: "src/popup/popup.css", dest: "popup" },
  {
    src: "src/popup/fonts/*.woff2",
    dest: "popup/fonts",
  },
  { src: "src/options/index.html", dest: "options" },
  { src: "src/options/options.css", dest: "options" },
  {
    src: "src/popup/fonts/*.woff2",
    dest: "options/fonts",
  },
  { src: "src/offscreen/audioProcessor.html", dest: "offscreen" },
];

/** ES-module entries: service worker (manifest type: module), popup, options, offscreen. */
const esModuleBuild = defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/serviceWorker": resolve(
          rootDir,
          "src/background/serviceWorker.ts"
        ),
        "popup/popup": resolve(rootDir, "src/popup/popup.ts"),
        "options/options": resolve(rootDir, "src/options/options.ts"),
        "offscreen/audioProcessor": resolve(
          rootDir,
          "src/offscreen/audioProcessor.ts"
        ),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: staticCopyTargets,
    }),
  ],
});

/**
 * Content script: IIFE bundle for classic script injection (no manifest type: module).
 * Must be a single file with no top-level import/export statements.
 */
const contentScriptBuild = defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        "content/index": resolve(rootDir, "src/content/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "iife",
        name: "SafeViewContent",
        inlineDynamicImports: true,
      },
    },
  },
});

export default defineConfig(({ mode }) =>
  mode === "contentIife" ? contentScriptBuild : esModuleBuild
);

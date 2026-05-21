// SafeView — vite.config.ts
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Bundle MV3 service worker, content scripts, popup, and options into dist/.

import { resolve } from "path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const rootDir = resolve(__dirname);

export default defineConfig({
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
        "content/index": resolve(rootDir, "src/content/index.ts"),
        "popup/popup": resolve(rootDir, "src/popup/popup.ts"),
        "options/options": resolve(rootDir, "src/options/options.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
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
      ],
    }),
  ],
});

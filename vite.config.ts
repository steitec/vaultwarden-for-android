import { defineConfig } from "vite";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "firefox121",
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  plugins: [
    {
      name: "copy-manifest",
      closeBundle() {
        mkdirSync("dist", { recursive: true });
        copyFileSync("src/manifest.json", "dist/manifest.json");
      },
    },
  ],
});

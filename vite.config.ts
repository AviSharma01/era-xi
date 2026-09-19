import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "data/processed/era-draft/web/v1/public",
  build: {
    outDir: "dist-web",
    manifest: true,
  },
});

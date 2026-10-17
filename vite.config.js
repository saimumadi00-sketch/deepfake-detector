import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so dist/ works from any path: a domain root, or a
  // subpath such as GitHub Pages' /<repo>/.
  base: "./",
  // Transformers.js ships its own ONNX Runtime WASM; pre-bundling breaks its
  // worker/wasm path resolution.
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  test: { environment: "node" },
});

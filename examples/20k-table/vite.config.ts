import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Still a production build (React without dev checks), but unminified so the
  // CPU profiles zerospikes prints on a failure name the real functions.
  build: { minify: false, sourcemap: true },
});

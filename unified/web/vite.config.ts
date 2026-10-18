import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "/_app/",
  build: {
    outDir: "../app-dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/pdfjs-dist/")) return "pdf";
          if (id.includes("/@rjsf/") || id.includes("/ajv")) return "forms";
          if (/\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
});

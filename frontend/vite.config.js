import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          scanner: ["@zxing/browser", "@zxing/library"],
          icons: ["lucide-react"]
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});

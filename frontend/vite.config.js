import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

function quarantineCashierArtifacts() {
  let downloadsDirectory = "";
  return {
    name: "quarantine-cashier-artifacts",
    configResolved(config) {
      downloadsDirectory = path.resolve(config.root, config.build.outDir, "downloads");
    },
    closeBundle() {
      if (!fs.existsSync(downloadsDirectory)) return;
      for (const name of fs.readdirSync(downloadsDirectory)) {
        if (/^VISIONPOS-(?:Cashier(?:_[\w.-]+)?(?:-setup)?|Setup(?:-[\w.-]+)?)\.exe(?:\.sig)?$/i.test(name)) {
          fs.rmSync(path.join(downloadsDirectory, name), { force: true });
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), quarantineCashierArtifacts()],
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

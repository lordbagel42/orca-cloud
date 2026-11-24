import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.ORCA_BACKEND_URL || "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          react: ["react", "react-dom"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});

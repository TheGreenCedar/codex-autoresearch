import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    emptyOutDir: true,
    minify: true,
    outDir: "../assets/dashboard-build",
    sourcemap: false,
    lib: {
      entry: "src/main.tsx",
      name: "AutoresearchDashboard",
      formats: ["iife"],
      fileName: () => "dashboard-app.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "dashboard-app.[ext]",
      },
    },
  },
});

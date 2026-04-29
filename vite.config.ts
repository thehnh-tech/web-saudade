import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: "0.0.0.0",
    https: {},
    proxy: {
      "/api": "http://localhost:4000",
      "/storage": "http://localhost:4000",
      "/health": "http://localhost:4000"
    }
  }
});

import { defineConfig } from "vite";

export default defineConfig({
  build: { rollupOptions: { input: { caller: "index.html", agent: "agent.html", records: "records.html" } } },
});

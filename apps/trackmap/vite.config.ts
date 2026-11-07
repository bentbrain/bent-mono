import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import deployment from "./vercel.json";

// Exercise the deployed security policy in browser verification too.
const headers = Object.fromEntries(
  deployment.headers[0].headers.map((header) => [header.key, header.value]),
);
export default defineConfig({ plugins: [react()], preview: { headers } });

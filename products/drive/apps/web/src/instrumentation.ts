import { registerOTel } from "@vercel/otel";

export function register(): void {
  registerOTel({ serviceName: "bent-drive-copilot" });
}

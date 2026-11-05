import { storefrontApiHandler } from "@/server/storefront-http-api";

export function POST(request: Request) {
  return storefrontApiHandler(request);
}

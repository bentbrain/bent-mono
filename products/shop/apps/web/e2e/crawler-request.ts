import type { APIRequestContext } from "@playwright/test";

export function requestCrawlerPage(request: APIRequestContext, path: string, userAgent: string) {
  return request.get(path, {
    headers: { "User-Agent": userAgent },
    maxRedirects: 0,
    // Retry one interrupted read. Playwright does not retry HTTP errors here;
    // response status, redirects and indexing assertions still fail normally.
    maxRetries: 1,
  });
}

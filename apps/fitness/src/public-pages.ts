/**
 * Pages anyone can read without signing in or account services: they render
 * outside Clerk, and before the app is configured. `/llms.txt` tells AI
 * assistants how to connect.
 */
const publicPages = new Set(["/privacy", "/llms.txt"]);

/** Whether a location's path is a public page, ignoring trailing slashes. */
export function isPublicPage(pathname: string) {
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === "/") end--;
  return publicPages.has(pathname.slice(0, end));
}

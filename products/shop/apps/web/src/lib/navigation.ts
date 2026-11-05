/**
 * Update the visible URL when the destination content is already mounted.
 * Next.js observes native history updates, so only call this after the current
 * route can be replaced without interrupting an in-flight interaction.
 */
export function replaceMountedRoute(url: string) {
  window.history.replaceState(null, "", url);
}

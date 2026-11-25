import { useEffect } from "react";
import { useLocation } from "@tanstack/react-router";
import toolbar from "../../.feedback-toolbar.json";

/**
 * Loads the feedback toolbar. It stays hidden on the account pages, where
 * Clerk's full-screen menu on phones would sit beneath it.
 */
export function FeedbackToolbar() {
  const account = useLocation({
    select: (location) =>
      location.pathname === "/account" ||
      location.pathname.startsWith("/account/"),
  });
  useEffect(() => {
    const mobile = matchMedia("(max-width:760px)");
    function place() {
      const host = document.querySelector("[data-feedback-host]");
      if (!(host instanceof HTMLElement)) return;
      host.style.setProperty(
        "bottom",
        mobile.matches ? "calc(88px + env(safe-area-inset-bottom))" : "20px",
        "important",
      );
      host.style.setProperty(
        "max-height",
        mobile.matches ? "calc(100dvh - 124px)" : "calc(100dvh - 36px)",
        "important",
      );
      host.style.setProperty(
        "visibility",
        account ? "hidden" : "visible",
        "important",
      );
    }
    const observer = new MutationObserver(place);
    observer.observe(document.documentElement, { childList: true });
    mobile.addEventListener("change", place);
    place();
    return () => {
      observer.disconnect();
      mobile.removeEventListener("change", place);
    };
  }, [account]);
  return (
    <script
      defer
      src={`${toolbar.server}/embed.js`}
      data-project={toolbar.projectId}
    />
  );
}

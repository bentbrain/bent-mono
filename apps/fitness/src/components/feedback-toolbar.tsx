import { useEffect } from "react";
import toolbar from "../../.feedback-toolbar.json";

export function FeedbackToolbar() {
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
    }
    const observer = new MutationObserver(place);
    observer.observe(document.documentElement, { childList: true });
    mobile.addEventListener("change", place);
    place();
    return () => {
      observer.disconnect();
      mobile.removeEventListener("change", place);
    };
  }, []);
  return (
    <script
      defer
      src={`${toolbar.server}/embed.js`}
      data-project={toolbar.projectId}
    />
  );
}

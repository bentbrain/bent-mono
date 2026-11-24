import {
  createRootRoute,
  HeadContent,
  Scripts,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import { readiness } from "../server/functions";
import { FeedbackToolbar } from "../components/feedback-toolbar";
import css from "../styles.css?url";
export const Route = createRootRoute({
  loader: () => readiness(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: "Fitness · bent.build" },
      {
        name: "description",
        content:
          "Private tracker for strength sessions, runs, food and bodyweight. Access is by invitation.",
      },
      { name: "theme-color", content: "#0647ff" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icon.svg" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  component: Root,
  errorComponent: ({ reset }) => (
    <main className="landing">
      <h1>We could not open your plan.</h1>
      <p>
        Check your connection, then try again. Pending changes remain on this
        device.
      </p>
      <button onClick={reset}>Try again</button>
    </main>
  ),
});
/** Pages that open without account services. */
const publicPages = new Set(["/privacy"]);
function Root() {
  const { ready } = Route.useLoaderData();
  const open = useLocation({
    select: (location) => publicPages.has(location.pathname),
  });
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {open ? (
          <Outlet />
        ) : ready ? (
          <ClerkProvider>
            <Outlet />
          </ClerkProvider>
        ) : (
          <main className="landing">
            <div className="wordmark">bent/fitness</div>
            <h1>Account services need setup.</h1>
            <p>
              The app owner needs to configure authentication, the fitness
              database and invited email addresses.
            </p>
          </main>
        )}
        <FeedbackToolbar />
        <Scripts />
      </body>
    </html>
  );
}

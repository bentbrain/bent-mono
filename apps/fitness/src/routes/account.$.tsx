import { createFileRoute, Link } from "@tanstack/react-router";
import {
  SignInButton,
  UserProfile,
  useAuth,
} from "@clerk/tanstack-react-start";
import { Button } from "@bent/ui/button";

export const Route = createFileRoute("/account/$")({
  component: Account,
});

/** Manage account, with a URL for each page, such as /account/api-keys. */
function Account() {
  const { userId, isLoaded } = useAuth();
  if (!isLoaded) return <p className="loading">Loading account…</p>;
  return (
    <main className="auth-page account-page">
      <Link className="text-link" to="/" search={{}}>
        Back to Fitness
      </Link>
      {userId ? (
        <UserProfile routing="path" path="/account" />
      ) : (
        <SignInButton mode="modal">
          <Button appearance="primary">Sign in</Button>
        </SignInButton>
      )}
    </main>
  );
}

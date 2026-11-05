import { SignOutButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
export default function AccessPage() {
  return (
    <main className="login-shell">
      <div className="login-card">
        <h1 className="text-2xl font-semibold">An invitation is needed</h1>
        <p className="my-5 leading-7 text-muted-foreground">
          This account does not have access to the guide. Use the invitation
          your host sent you, or ask them to check your access.
        </p>
        <SignOutButton redirectUrl="/sign-in">
          <Button>Sign out</Button>
        </SignOutButton>
      </div>
    </main>
  );
}

import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth-shell";
export default function SignInPage() {
  return (
    <AuthShell>
      <p className="mb-6 text-sm leading-6 text-muted-foreground">
        apartment guest guide. sign in with the account your host invited.
      </p>
      <SignIn fallbackRedirectUrl="/" />
    </AuthShell>
  );
}

import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth-shell";
export default function SignUpPage() {
  return (
    <AuthShell invitation>
      <SignUp fallbackRedirectUrl="/" />
    </AuthShell>
  );
}

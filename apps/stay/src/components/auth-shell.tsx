import Link from "next/link";
import { House } from "lucide-react";
export function AuthShell({
  children,
  invitation = false,
}: {
  children: React.ReactNode;
  invitation?: boolean;
}) {
  return (
    <main className="login-shell">
      <div className="w-full max-w-md">
        <Link href="/" className="brand-link mb-6">
          <House size={16} strokeWidth={1.5} />
          bent.stay
        </Link>
        <h1 className="sr-only">
          {invitation ? "Accept your invitation" : "Sign in"}
        </h1>
        {children}
      </div>
    </main>
  );
}

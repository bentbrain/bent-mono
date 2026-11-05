"use client";
import { SignInButton } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { Button, type ButtonProps } from "./ui/button";

function SignInButtonWrapper({ ...props }: ButtonProps) {
  const pathname = usePathname();

  if (pathname === "/sign-in") return null;
  return (
    <Button asChild {...props}>
      <SignInButton />
    </Button>
  );
}

export default SignInButtonWrapper;

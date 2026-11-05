import { ClerkProvider } from "@clerk/nextjs";
import React from "react";

function Layout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}

export default Layout;

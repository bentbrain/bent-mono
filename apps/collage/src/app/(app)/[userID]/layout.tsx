import React from "react";

async function Layout({ children }: { children: React.ReactNode }) {
  return (
    <main className="container mx-auto grid place-items-center">
      {children}
    </main>
  );
}

export default Layout;

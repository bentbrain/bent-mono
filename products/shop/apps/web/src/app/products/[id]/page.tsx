import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { productPath } from "@/lib/products";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={null}>
      <LegacyProductRedirect params={params} />
    </Suspense>
  );
}

async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(productPath(id));
  return null;
}

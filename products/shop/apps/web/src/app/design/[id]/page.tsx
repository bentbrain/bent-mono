import type { Metadata } from "next";
import { Suspense } from "react";

import { DesignMobileRoute } from "@/components/design-mobile-route";
import { DesignPageSkeleton } from "@/components/route-skeletons";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
};

export default function DesignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ camera?: string | string[]; upload?: string | string[] }>;
}) {
  return (
    <Suspense fallback={<DesignPageSkeleton />}>
      <DesignPageContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function DesignPageContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ camera?: string | string[]; upload?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <DesignMobileRoute cameraLaunch={query.camera === "1"} uploadLaunch={query.upload === "1"} id={id} />;
}

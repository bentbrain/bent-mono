"use client";

import {
  COTTON_TOTE_BASE_PRODUCT_ID,
  STAPLE_TEE_BASE_PRODUCT_ID,
  type BaseProductSlug,
} from "@forever-tee/contracts/product-projection";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { createConfiguredProductFamily } from "@/client/product-api";
import { Button } from "@/components/ui/button";
import { productPath } from "@/lib/products";

async function prepareLaunchProducts(designId: string) {
  try {
    const products = await createConfiguredProductFamily({
      baseProductIds: [
        STAPLE_TEE_BASE_PRODUCT_ID,
        COTTON_TOTE_BASE_PRODUCT_ID,
      ],
      designId,
    });
    const shirt = products.find(
      (product) => product.baseProductId === STAPLE_TEE_BASE_PRODUCT_ID,
    );
    const tote = products.find(
      (product) => product.baseProductId === COTTON_TOTE_BASE_PRODUCT_ID,
    );
    return {
      "cotton-tote": tote
        ? { error: false, productId: tote.id }
        : { error: true },
      "staple-tee": shirt
        ? { error: false, productId: shirt.id }
        : { error: true },
    };
  } catch {
    return {
      "cotton-tote": { error: true },
      "staple-tee": { error: true },
    };
  }
}

export function ProductProjectionPreview({
  designId,
  slug,
}: {
  designId: string;
  slug: BaseProductSlug;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const preparationQuery = useQuery({
    queryFn: () => prepareLaunchProducts(designId),
    queryKey: ["product-projections", designId],
    retry: false,
  });
  const selected = preparationQuery.data?.[slug];

  useEffect(() => {
    if (!selected?.productId) return;
    router.replace(productPath(selected.productId));
  }, [router, selected?.productId]);

  if (preparationQuery.isPending || selected?.productId) {
    return <ProjectionStatus>Preparing your products…</ProjectionStatus>;
  }

  return (
    <main className="grid flex-1 place-items-center bg-background px-5 pt-14 text-primary">
      <div className="grid max-w-72 justify-items-center gap-4 text-center">
        <p className="text-sm leading-6" role="alert">
          We couldn&apos;t prepare this product. Your design is unchanged.
        </p>
        <Button
          type="button"
          className="min-h-11 rounded-none border border-primary px-4 font-mono text-xs font-bold uppercase"
          disabled={preparationQuery.isFetching}
          onClick={() => {
            void queryClient.invalidateQueries({
              queryKey: ["product-projections", designId],
            });
          }}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}

function ProjectionStatus({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid flex-1 place-items-center bg-background px-5 pt-14 text-center text-primary">
      <p className="font-mono text-xs font-bold" role="status">
        {children}
      </p>
    </main>
  );
}

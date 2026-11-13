import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ConfiguredProductFamily } from "../components/configured-product-family";
const family = createServerFn({ method: "GET" })
  .validator((input: { id: string; query: Record<string, string> }) => input)
  .handler(async ({ data }) => {
    const { loadProductFamily } = await import("../server/product-page");
    return loadProductFamily(data.id, data.query);
  });
export const Route = createFileRoute("/product/$id")({
  validateSearch: (search: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(search).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    family({ data: { id: params.id, query: deps } }),
  component: Product,
});
function Product() {
  const data = Route.useLoaderData();
  return (
    <main className="flex-1 bg-background px-[clamp(1rem,4vw,4rem)] pt-14 pb-4 text-primary">
      <ConfiguredProductFamily {...data} />
    </main>
  );
}

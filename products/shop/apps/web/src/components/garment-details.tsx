import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";

export function BaseProductDescription({
  baseProductSlug,
}: {
  baseProductSlug: BaseProductSlug;
}) {
  if (baseProductSlug === "cotton-tote") {
    return (
      <div className="grid gap-4 text-[0.78rem] leading-[1.6]">
        <p className="max-w-[42rem]">
          Printed on the <strong>AS Colour Carrie Tote 1001</strong>, a large,
          one-size cotton canvas tote with reinforced shoulder straps.
        </p>

        <dl className={detailListClassName}>
          <div>
            <dt>Fabric</dt>
            <dd>Heavyweight 320 GSM, 100% cotton canvas</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>42 × 42 cm with a 9.5 cm gusset</dd>
          </div>
          <div>
            <dt>Straps</dt>
            <dd>Reinforced, 72 cm long</dd>
          </div>
        </dl>

        <SpecificationSource href="https://www.ascolour.com.au/carrie-tote-1001/" />
      </div>
    );
  }

  return (
    <div className="grid gap-4 text-[0.78rem] leading-[1.6]">
      <p className="max-w-[42rem]">
        Printed on the <strong>AS Colour Staple Tee 5001</strong>, a midweight,
        regular-fit tee made from combed cotton.
      </p>

      <dl className={detailListClassName}>
        <div>
          <dt>Fabric</dt>
          <dd>Midweight 180 GSM, 28-singles, 100% combed cotton</dd>
        </div>
        <div>
          <dt>Fit</dt>
          <dd>Regular fit</dd>
        </div>
        <div>
          <dt>Construction</dt>
          <dd>Side seamed with neck ribbing and double-needle hems</dd>
        </div>
      </dl>

      <SpecificationSource href="https://www.ascolour.com.au/staple-tee-5001/" />
    </div>
  );
}

function SpecificationSource({ href }: { href: string }) {
  return (
    <p className="text-[0.66rem] opacity-72 [&_a]:underline [&_a]:underline-offset-[0.2em]">
      Product specification from{" "}
      <a href={href} rel="noreferrer" target="_blank">
        AS Colour
      </a>
      .
    </p>
  );
}

const detailListClassName =
  "grid border-t border-primary/35 [&>div]:grid [&>div]:grid-cols-[minmax(5rem,0.35fr)_1fr] [&>div]:gap-3 [&>div]:border-b [&>div]:border-primary/35 [&>div]:py-[0.55rem] [&_dt]:text-[0.66rem] [&_dt]:font-bold [&_dt]:tracking-[0.06em]";

const stapleTeeSizes = [
  { bodyLength: "68", bodyWidth: "43", name: "XS" },
  { bodyLength: "71", bodyWidth: "47", name: "S" },
  { bodyLength: "75", bodyWidth: "52", name: "M" },
  { bodyLength: "78.5", bodyWidth: "56.5", name: "L" },
  { bodyLength: "82", bodyWidth: "61", name: "XL" },
  { bodyLength: "83.5", bodyWidth: "64", name: "2XL" },
  { bodyLength: "85", bodyWidth: "68", name: "3XL" },
  { bodyLength: "87", bodyWidth: "75", name: "4XL" },
  { bodyLength: "89", bodyWidth: "80", name: "5XL" },
];

export function GarmentSizeGuide() {
  return (
    <section className="min-w-0 text-[0.78rem] leading-[1.6]">
      <p className="mb-1 text-right text-[0.6rem] tracking-[0.04em] opacity-72 sm:hidden">
        scroll to see all sizes →
      </p>
      <div className="relative after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-6 after:bg-linear-to-l after:from-background after:to-transparent sm:after:hidden">
        <div className="max-w-full overflow-x-auto overscroll-x-contain">
          <table className="w-full min-w-[32rem] table-fixed border-collapse text-center text-[0.68rem] [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:bg-background [&_th:first-child]:text-left [&_th]:border-b [&_th]:border-primary/35 [&_th]:px-[0.35rem] [&_th]:py-2 [&_th]:whitespace-nowrap [&_td]:border-b [&_td]:border-primary/35 [&_td]:px-[0.35rem] [&_td]:py-2 [&_td]:whitespace-nowrap [&_thead_th]:text-[0.6rem] [&_thead_th]:tracking-[0.04em]">
            <colgroup>
              <col className="w-28" />
              {stapleTeeSizes.map((size) => (
                <col key={size.name} />
              ))}
            </colgroup>
            <caption className="sr-only">
              Staple Tee 5001 garment measurements in centimetres
            </caption>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                {stapleTeeSizes.map((size) => (
                  <th key={size.name} scope="col">
                    {size.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Body width</th>
                {stapleTeeSizes.map((size) => (
                  <td key={size.name}>{size.bodyWidth}</td>
                ))}
              </tr>
              <tr>
                <th scope="row">Body length</th>
                {stapleTeeSizes.map((size) => (
                  <td key={size.name}>{size.bodyLength}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-[0.6rem] text-[0.66rem] opacity-72">
        Measurements can vary by up to 2.5 cm within AS Colour&apos;s tolerance.
      </p>
    </section>
  );
}

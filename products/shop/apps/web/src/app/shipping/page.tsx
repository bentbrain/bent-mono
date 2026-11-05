import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";

import {
  PolicyPage,
  PolicySection,
  policyListClassName,
} from "@/components/policy-page";
import { ShippingTimingCopy } from "@/components/shipping-timing";
import {
  FREE_DELIVERY_THRESHOLD_AUD,
  STANDARD_DELIVERY_FEE_AUD,
} from "@/lib/shipping-policy";
import { getCachedStorefrontFulfilmentEstimate } from "@/lib/fulfilment-estimate-data";

export const metadata: Metadata = {
  title: "Shipping | bent.shop",
  description: "Australian production times, shipping estimates, charges, and parcel handling.",
};

export default function ShippingPage() {
  return (
    <PolicyPage
      title="Shipping"
      lastUpdated="1 September 2026"
      intro={(
        <p>
          bent.shop ships made-to-order products to Australian addresses using our delivery partners&apos; regular, non-express services.
        </p>
      )}
    >
      <PolicySection title="Shipping area and price">
        <ul className={policyListClassName}>
          <li>We ship only to Australian addresses.</li>
          <li>Shipping costs AUD {STANDARD_DELIVERY_FEE_AUD} when the discounted merchandise subtotal is below AUD {FREE_DELIVERY_THRESHOLD_AUD}.</li>
          <li>Shipping is free when the discounted merchandise subtotal is AUD {FREE_DELIVERY_THRESHOLD_AUD} or more.</li>
          <li>We do not offer express shipping, pickup, or international shipping.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Production and shipping timing">
        <Suspense fallback={<p>Each item is printed after payment. Current production and shipping estimates are loading.</p>}>
          <ShippingTiming />
        </Suspense>
        <p>
          These timeframes are estimates, not guarantees. Production demand, carrier delays, remote-area delivery, public holidays, weather, and address problems can change them.
        </p>
        <p>
          If we learn that an order is materially delayed or cannot be supplied, we will contact you with the available options. Your rights under Australian Consumer Law remain available.
        </p>
      </PolicySection>

      <PolicySection title="Addresses">
        <p>
          Enter a complete Australian delivery address at checkout. PO Boxes and Parcel Lockers are accepted when our delivery partners can service the address.
        </p>
        <p>
          Contact <a className="underline" href="mailto:support@bent.build">support@bent.build</a> as soon as possible if you need to change the address. We cannot promise a change after production begins.
        </p>
      </PolicySection>

      <PolicySection title="Split shipments and tracking">
        <p>
          An order may arrive in more than one parcel. Shipping updates are sent to the email address used at checkout.
        </p>
      </PolicySection>

      <PolicySection title="Parcel sender and returns">
        <p>
          Delivery partners may use generic sender wording on the parcel. The printed sender address is not our returns address. Contact us before posting anything back. Read <Link className="underline" href="/returns">Returns and remedies</Link> for damaged, faulty, incorrect, or missing items.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}

async function ShippingTiming() {
  // Keep shared runtime estimates out of the static policy shell.
  await io();
  const estimate = await getCachedStorefrontFulfilmentEstimate();
  return <ShippingTimingCopy estimate={estimate} />;
}

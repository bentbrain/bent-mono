import type { Metadata } from "next";
import Link from "next/link";

import {
  PolicyPage,
  PolicySection,
  policyListClassName,
} from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Privacy | bent.shop",
  description: "How bent.shop handles personal information.",
};

export default function PrivacyPage() {
  return (
    <PolicyPage
      title="Privacy"
      lastUpdated="24 September 2026"
      intro={(
        <p>
          bent.shop is an Australian online store. This notice explains how we handle photos, orders, support messages, and technical information. Contact <a className="underline" href="mailto:support@bent.build">support@bent.build</a> with a privacy question or request.
        </p>
      )}
    >
      <PolicySection title="What we collect">
        <ul className={policyListClassName}>
          <li>The photo you take, the cut-out artwork made from it, your design settings, product previews, and print-ready artwork.</li>
          <li>Browser data used to protect and return you to your draft.</li>
          <li>Your name, email, delivery address, optional shipping phone number, order, payment status, and delivery information. We use the phone number only when needed to produce and deliver your order. Our payment provider processes card details. We do not receive your full card number.</li>
          <li>Messages and evidence you send to support.</li>
          <li>Limited device, browser, IP address, security, and error information needed to operate and protect the store.</li>
          <li>Page visits, interactions, browser errors, and masked session recordings to understand where the store fails or is difficult to use. Recordings show page styling and public interface text while hiding form inputs, sensitive text, photos, and product imagery. We exclude the Manage order page and do not create persistent visitor profiles or use advertising trackers. Analytics uses a separate browser-tab identifier, not your draft ownership credentials.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Image checks">
        <p>
          We check submitted images against our <Link className="underline" href="/content-rules">content rules</Link> and remove the background before saving the artwork. These checks can make mistakes. They do not prove ownership or consent, so you remain responsible for having the rights and permission needed to use the image.
        </p>
      </PolicySection>

      <PolicySection title="Why we use the information">
        <ul className={policyListClassName}>
          <li>To create, save, display, share, and print your design.</li>
          <li>To manage carts, payments, production, delivery, cancellations, and remedies.</li>
          <li>To protect the service, enforce the <Link className="underline" href="/content-rules">content rules</Link>, diagnose failures, and prevent duplicate or unauthorised operations.</li>
          <li>To answer support requests and meet record-keeping and legal obligations.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Who handles it">
        <p>
          We share information only as needed with companies that provide payment, hosting, image processing, production, delivery, email, support, and usage analytics services. We may also disclose information when required by law or when needed to protect our rights or someone else&apos;s safety.
        </p>
        <p>
          These companies may process information in Australia and overseas, including in the United States and other countries where they operate.
        </p>
      </PolicySection>

      <PolicySection title="Product links and draft access">
        <p>
          A finished product page is public to anyone who has its link. A person with the link can view, share, and buy that product. Do not create a product if that public-by-link access is unsuitable for the portrait.
        </p>
        <p>
          An unfinished draft is linked to the browser that created it. Clearing browser data, changing browsers, or changing devices may remove your ability to return to it.
        </p>
      </PolicySection>

      <PolicySection title="Retention and deletion">
        <ul className={policyListClassName}>
          <li>An unfinished draft with no finished product becomes eligible for deletion 30 days after its last successful change.</li>
          <li>We process a paid-order webhook in memory and keep only its event identifier, integrity hash, status, and delivery metadata for up to 30 days. We do not retain the webhook body.</li>
          <li>Our working copy of the delivery address and contact details is deleted 45 days after an order reaches a completed, cancelled, or refunded state. The commerce, payment, production, or delivery services may retain their own order records for longer.</li>
          <li>Protected-order access records contain a one-way order reference rather than the address or email and are kept for up to two years.</li>
          <li>If you unpublish a product that has never been ordered, its images become eligible for deletion after 30 days.</li>
          <li>For an unpublished product that has been ordered, source photos and previews become eligible for deletion at least 45 days after the latest delivery, once the order is complete and no issue remains open.</li>
          <li>Print-ready files for an unpublished, ordered product become eligible for deletion two years after the latest delivery or resolution of the latest product issue, whichever is later.</li>
          <li>We may keep order, financial, security, and legal records after image deletion. Active products remain stored while they are available to view or buy.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Access, correction, complaints, and deletion requests">
        <p>
          Email <a className="underline" href="mailto:support@bent.build">support@bent.build</a> to ask what personal information we hold about you, request a correction or deletion, or make a privacy complaint. Include enough information to locate the relevant draft or order, but do not email payment-card details or a copy of identity documents unless we ask for a specific secure verification step.
        </p>
        <p>
          We may need to keep information connected with an order, dispute, security check, legal obligation, or unresolved product issue. If you are not satisfied with our response, you can contact the Office of the Australian Information Commissioner.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}

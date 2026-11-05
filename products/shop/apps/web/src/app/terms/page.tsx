import type { Metadata } from "next";
import Link from "next/link";

import {
  PolicyPage,
  PolicySection,
  policyListClassName,
} from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Terms | bent.shop",
  description: "Terms for using bent.shop and ordering custom products.",
};

export default function TermsPage() {
  return (
    <PolicyPage
      title="Terms"
      intro={(
        <p>
          These terms apply when you use bent.shop or place an order. Australian Consumer Law rights still apply and are not limited by these terms.
        </p>
      )}
    >
      <PolicySection title="You must be 18 or older">
        <p>
          bent.shop is for people aged 18 or older. By starting the camera journey, you confirm that you are at least 18, that you have the rights and permission needed to use every image you submit, and that the image follows our <Link className="underline" href="/content-rules">content rules</Link>.
        </p>
      </PolicySection>

      <PolicySection title="Your image and permission to make the product">
        <p>
          You keep the rights you already hold in your image. You give bent.shop and the companies that help us operate the site and fulfil orders permission to process, store, reproduce, display, and transmit it only as needed to provide the service, produce and deliver orders, provide support, enforce these terms, and meet legal obligations.
        </p>
        <p>
          Do not submit an image you are not allowed to use. You are responsible for obtaining permission from every identifiable person and from the owner of any protected artwork, logo, or other material in the image.
        </p>
      </PolicySection>

      <PolicySection title="Drafts and public product links">
        <p>
          An unfinished draft is linked to the browser that created it. If you clear browser data or change browser or device, we may not be able to restore access.
        </p>
        <p>
          Finished product pages are public to anyone with the link. Anyone with that link can view, share, and buy the product while it remains active. Keep the link private if you do not want it shared, and do not finish a product when public-by-link access would be inappropriate.
        </p>
      </PolicySection>

      <PolicySection title="Products, previews, and availability">
        <ul className={policyListClassName}>
          <li>Products are made to order from the design, product, colour, size, and placement shown before you add them to the cart.</li>
          <li>Screen colour and scale can differ slightly from the physical print. This does not remove your rights when goods fail a consumer guarantee.</li>
          <li>A shirt requires an explicit size selection. Check it before ordering. Tote bags have one offered size.</li>
          <li>We do not substitute another product, colour, size, or artwork when the exact selection is unavailable.</li>
          <li>We may pause new orders when a product is unavailable or we cannot confirm that an order can be made correctly. Existing paid orders continue to be handled.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Orders and payment">
        <p>
          Prices and delivery charges appear in Australian dollars. An order is accepted when payment succeeds and we send the order confirmation, subject to availability and security checks. If we cannot make the order, we will contact you and provide the remedy required by law, which may include cancellation and a refund.
        </p>
      </PolicySection>

      <PolicySection title="Address changes and cancellation">
        <p>
          Contact <a className="underline" href="mailto:support@bent.build">support@bent.build</a> as soon as possible if you need to change an address or cancel an order. We cannot promise a change or cancellation after production begins.
        </p>
      </PolicySection>

      <PolicySection title="Returns and consumer guarantees">
        <p>
          Because each item is made to order, bent.shop does not accept a return or exchange for a simple change of mind, including choosing the wrong size. This rule does not apply when Australian Consumer Law gives you a right to a repair, replacement, refund, compensation, or another remedy. Read the <Link className="underline" href="/returns">Returns and remedies policy</Link> for the contact process.
        </p>
      </PolicySection>

      <PolicySection title="Service limits and changes">
        <p>
          We may block or remove content, suspend a product, refuse a new order, or restrict use when needed for safety, rights complaints, fraud prevention, legal compliance, or service integrity. We will not use this clause to remove rights attached to an accepted order or under Australian Consumer Law.
        </p>
        <p>
          We may update these terms as the service changes. The terms shown when you place an order apply to that order unless a later change gives you greater rights or the law requires otherwise.
        </p>
      </PolicySection>

      <PolicySection title="Contact">
        <p>
          Email <a className="underline" href="mailto:support@bent.build">support@bent.build</a>.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}

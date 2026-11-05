import type { Metadata } from "next";

import {
  PolicyPage,
  PolicySection,
  policyListClassName,
} from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Returns and remedies | bent.shop",
  description: "Change-of-mind rules and Australian Consumer Law remedies for bent.shop orders.",
};

export default function ReturnsPage() {
  return (
    <PolicyPage
      title="Returns + remedies"
      intro={(
        <p>
          bent.shop makes each item for its order. We do not accept change-of-mind returns, but that never replaces or limits your rights under Australian Consumer Law.
        </p>
      )}
    >
      <PolicySection title="Change of mind">
        <p>
          We do not offer a refund, exchange, or remake because you changed your mind, chose the wrong size or colour, no longer want the image, or found another product you prefer. Check the preview, product, colour, and shirt size before adding an item to the cart.
        </p>
      </PolicySection>

      <PolicySection title="When something is wrong">
        <p>
          Contact <a className="underline" href="mailto:support@bent.build">support@bent.build</a> if an item is faulty, damaged, materially different from its description, printed with the wrong supplied design, missing, or otherwise fails a consumer guarantee.
        </p>
        <p>
          Include your order number, a clear description, and photos when they can show the problem.
        </p>
      </PolicySection>

      <PolicySection title="Available remedies">
        <p>
          The remedy depends on the problem and Australian Consumer Law. It may be a repair, replacement, refund, compensation for reasonably foreseeable loss, or another required remedy. You can choose a refund or replacement for a major failure. For a minor failure, we may first provide a repair or replacement within a reasonable time.
        </p>
        <p>
          Our policies do not replace your consumer guarantees.
        </p>
      </PolicySection>

      <PolicySection title="Before returning an item">
        <ul className={policyListClassName}>
          <li>Contact us before posting anything.</li>
          <li>Do not send a parcel to the generic sender address printed on the package.</li>
          <li>We will tell you whether a return is needed and provide the correct instructions.</li>
          <li>When the law makes bent.shop responsible for return costs, we will arrange or reimburse reasonable postage.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Cancellations before production">
        <p>
          Contact <a className="underline" href="mailto:support@bent.build">support@bent.build</a> as soon as possible if you need to cancel an order. We cannot promise a change-of-mind cancellation after production begins, but consumer guarantees and any other legal rights still apply.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}

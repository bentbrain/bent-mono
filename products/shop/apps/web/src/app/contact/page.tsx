import type { Metadata } from "next";

import { PolicyPage, PolicySection } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Contact | bent.shop",
  description: "Contact bent.shop about an order, design, privacy request, or rights concern.",
};

export default function ContactPage() {
  return (
    <PolicyPage
      title="Contact"
      intro={(
        <p>
          Email <a className="underline" href="mailto:support@bent.build">support@bent.build</a>.
        </p>
      )}
    >
      <PolicySection title="Order or delivery problem">
        <p>
          Include your order number and the email address used at checkout. Add photos when they help show a print, garment, damage, or parcel issue. Do not email payment-card details.
        </p>
        <p>
          Contact us as soon as possible for an address change or cancellation. We cannot promise a change after production begins.
        </p>
      </PolicySection>

      <PolicySection title="Privacy, image, or rights concern">
        <p>
          Include the product link or draft reference and explain what you want us to review. We can investigate access, correction, deletion, privacy, copyright, likeness-consent, and safety concerns. A public product may be suspended while we review it.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}

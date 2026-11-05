import type { Metadata } from "next";

import {
  PolicyPage,
  PolicySection,
  policyListClassName,
} from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Content rules | bent.shop",
  description: "Rules for portraits and other images submitted to bent.shop.",
};

export default function ContentRulesPage() {
  return (
    <PolicyPage
      title="Content rules"
      intro={(
        <p>
          Submit only an image you are allowed to print and share through a public-by-link product page. bent.shop is for people aged 18 or older.
        </p>
      )}
    >
      <PolicySection title="Your declaration">
        <p>Before camera access, you must confirm that:</p>
        <ul className={policyListClassName}>
          <li>you are at least 18 years old;</li>
          <li>you own the image or have permission from its owner to use and print it;</li>
          <li>every identifiable person has consented to the photo, its use on products, and public-by-link display;</li>
          <li>the image and resulting product follow these rules.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Do not submit">
        <ul className={policyListClassName}>
          <li>sexual content involving a person under 18, or any sexual exploitation or abuse material;</li>
          <li>non-consensual intimate imagery, sexual violence, or content made to harass, shame, threaten, or exploit someone;</li>
          <li>graphic violence, instructions for serious wrongdoing, or material that promotes terrorism or violent extremist activity;</li>
          <li>hateful content that attacks or dehumanises people because of a protected characteristic;</li>
          <li>another person&apos;s private information, identity document, payment details, or other material you have no right to publish;</li>
          <li>copyrighted artwork, logos, trademarks, photos, or celebrity likenesses unless you have the rights and permissions needed for this use;</li>
          <li>content that is unlawful in Australia or where the product will be delivered.</li>
        </ul>
      </PolicySection>

      <PolicySection title="How we enforce these rules">
        <p>
          We check images against these rules before saving them. These checks can make mistakes and cannot establish copyright, ownership, or consent. Your declaration remains your responsibility when an image is accepted.
        </p>
        <p>
          We may reject an image, suspend a product during a rights or safety review, or permanently unpublish it when these rules, a law, or another person&apos;s rights require that action. Email <a className="underline" href="mailto:support@bent.build">support@bent.build</a> to report a product or ask for a review.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}

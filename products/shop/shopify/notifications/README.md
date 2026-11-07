# Customer notification emails

The store's 46 editable customer notifications are managed here. Shared branding and personalized image logic are generated from `sources/*.liquid`. Shopify's existing delivery, payment, tax, gift-card and refund branches remain in those source files. The order confirmation includes the previously approved Manage order section and uses Brisbane/AEST formatting for its deadline.

## Local work

```sh
npm --prefix shopify/notifications ci
npm --prefix shopify/notifications test
npm --prefix shopify/notifications run build
npm --prefix shopify/notifications run preview
```

Open http://127.0.0.1:43822. Choose a template and a phone or desktop width. The fixture uses two publicly featured product configurations, a black M shirt and black tote, with synthetic order/payment/address data. Preview links use inert fragment links inside a sandboxed frame. Sending emails and creating orders remain separate store operations.

Change shared type, spacing, colour and alignment in `branding/email.css`. Change the logo or personalized thumbnail generation in `branding/build-template.mjs`. Edit specific notification wording in its source. Rebuild after edits and refresh the preview. Generated Liquid and a SHA-256 manifest are written to ignored `dist/`.

The local renderer approximates Shopify's default CSS and provider-only filters. Its pickup-map expression has a preview-only compatibility substitution for a Shopify Ruby expression unsupported by LiquidJS. Check the final generated code in Shopify's preview before publishing, and verify its rendering in email clients. The preview clock is explicitly Australia/Brisbane, independent of the developer or CI machine's timezone.

## CI and sync

The Email notifications workflow parses and tests all templates, builds the distribution and uploads the exact generated files with a hash manifest. Publishing remains a separate Shopify Admin operation; the workflow runs without Shopify credentials.

Publish customer-notification templates through [Shopify Admin](https://admin.shopify.com/store/mktup7-hr/settings/notifications/customer): open the notification, Edit code, replace the HTML with the corresponding generated file, Preview, Save, then reopen and compare the saved code. Browser automation can perform these steps. Do not build CI around undocumented Admin endpoints or browser-session cookies.

Before a later sync, compare the current template against the last published artifact. Preserve intentional changes made in Shopify since the last sync. Native Revert to previous is available; the generator also preserves the original header and image markup and tests an exact reverse transformation back to its source.

Abandoned checkout is a separate Shopify Messaging automation and is not one of these 46 Liquid templates. Manage it through the link shown on its notification settings page; keep its subscription checks and recovery destination intact. Its native product section retains catalogue thumbnails. The approved copy explains: "Your design is saved with your cart. The images below show the blank products." Its header uses `branding/marketing-lockup.png`, which combines the existing icon and wordmark for the native logo-only header control.

## Images and privacy

Each configured line's server-verified `_productId` and purchased colour select its preview. Images use the existing revocable configured-product endpoint in PNG format. The order-management capability is never included in an image URL. Catalogue items without configuration metadata keep their original thumbnail. Deleting a design revokes the public image URL; already-cached copies are controlled by the email client. Image-blocking clients show alt text.

The store is configured to Australia/Brisbane. The confirmation's AEST label depends on that setting. Update the format and verify a known timestamp in Shopify if the store timezone changes.

Shipping confirmation and shipping update emails show the carrier, linked
tracking number and shipment items without order, Shop or store buttons.
Australia Post's raw `AUSTRALIA_POST` code displays as `Australia Post`, and its
tracking numbers link directly to the [carrier's documented tracking URL](https://auspost.com.au/content/dam/auspost_corp/media/documents/improving-your-customers-tracking-experience.pdf).
Other carriers retain their supplied tracking URLs.

# bent.shop pilot operations

This runbook is for the sole owner. Purchasing stays locked until the owner
explicitly authorizes reopening it, separately from deployment.
The owner chose manual cash-cost review on 5 September 2026. Monitor cash costs
manually; purchasing has no automatic AUD 500 cutoff, loss ledger or threshold
notification.

## First response and authority

The sole owner handles each alert, Exception Review and customer support case.
Review launch alerts immediately while attended. Pause new sales if an incident
cannot be understood promptly, if source financial records are incomplete, or
if the owner cannot monitor the first public orders. Public browsing and
existing paid-order processing continue during a Sales Pause.

Use Shopify Admin for order communication and refunds, Printify for provider
inspection, and guarded Actions for application operations. Do not place secrets,
capabilities, customer addresses or private invoice contents in GitHub. Customer
support replies are due within two business days, Monday to Friday excluding
Queensland public holidays. Do not promise a dispatch date the provider has not
confirmed.

For any incident, record the time, non-sensitive order or command reference,
current provider state, first response, next check and responsible owner in the
private operations record. A confirmed privacy or security problem follows
[security incident response](security-incident-response.md). An uncertain
mutation remains stopped until its actual provider outcome is known.

## Shopify vocabulary

Tags help the operator find work. They do not authorize a refund, release a D1
lease or override the Worker. Use the existing machine tag `BS_REMEDY_OPEN`
for an open remedy; retain it until the remedy has actually closed, because it
protects customer artwork from cleanup.

| Operator tag | Meaning and removal condition |
| --- | --- |
| `BS_EXCEPTION_REVIEW` | Record the matching D1 exception and resolution evidence; remove after both systems agree |
| `BS_RETRY_REVIEW` | A failed operation needs provider reconciliation before retry; remove after the exact operation is confirmed |
| `BS_REFUND_PENDING` | Refund requested but not confirmed; remove only after full intended refund settlement is verified |
| `BS_REMEDY_OPEN` | Complaint, replacement or refund case remains open; remove after customer outcome and any replacement delivery are recorded |
| `BS_FULFILMENT_LOCKED` | Address and line identity are committed to production; retain as an order-history marker |

Use Shopify financial and fulfilment statuses as provider facts. A cancellation
request, a tag or an asynchronous job acknowledgement is not a completed refund.
The store-wide Sales Pause belongs in D1 and the incident record, not on every
Shopify order. Display names and customer communications use `bent.shop`.
Machine tags and existing provider resource IDs remain compatibility keys.

## Diagnosis and stop conditions

| Alert or state | First response | Escalation and stop condition |
| --- | --- | --- |
| Manual Sales Pause | Read authenticated sales status and incident reason | Owner alone decides when to resume; never clear it as deployment cleanup |
| Stale catalogue or variant mapping | Check the exact failed refresh and provider status, then run the guarded refresh | Keep sales paused until both launch products have fresh, complete mappings; no substitutions |
| `VALIDATION_PENDING` | Check latest fraud and Australian address validation | Before deadline the customer may correct the address; missing validation after the deadline stays in review |
| `FRAUD_REVIEW_REQUIRED` | Review Shopify fraud assessment for the single order | Owner decides cancellation or further investigation; never bypass fraud by editing D1 |
| `ADDRESS_REVIEW_REQUIRED` | Compare current Shopify delivery address with validation result and hold deadline | After lock, contact Printify before promising any correction; unresolved delivery address stops production |
| `ORDER_CAPABILITY_*`, `LINE_IDENTITY_*`, `ORDER_QUANTITY_INVALID`, `DUPLICATE_ORDER_MISMATCH` | Compare immutable paid-order identities and signed intake evidence | Treat mismatch as an integrity incident; no reconstructed token, replacement identifier or manual production shortcut |
| `ORDER_STATE_CHANGED` | Inspect cancellation, refund, edit and payment state in Shopify | Stop automatic fulfilment until the exact order state is reconciled |
| `ORDER_MANAGEMENT_PENDING` | Inspect the recorded command and Shopify address/cancellation/refund outcome | No second cancellation call after a timeout; production remains held; see [Manage order](order-management.md) |
| `PRODUCT_LIFECYCLE_REVIEW` | Read current configured-product state and lifecycle audit | Rights/privacy complaints require suspension; already produced shipments still reconcile; no automatic cancellation decision |
| `PRINTIFY_MEDIA*`, `PRINTIFY_PRODUCT*` | Compare expected print-asset checksum, dimensions and exact provider resource | Authentication, duplicate, mismatch or ambiguous results stop creation; never upload/create another resource to guess recovery |
| `PRINTIFY_ORDER_*` | Compare immutable external order ID, lines, quantities and provider state | An uncertain create/send must be read back and reconciled; no duplicate create or send-to-production |
| `SHOPIFY_FULFILMENT_BUSY`, `SHOPIFY_FULFILMENT_RETRY`, `SHOPIFY_FULFILMENT_AMBIGUOUS` | Read each recorded shipment and Shopify fulfilment quantities/tracking | Do not resend a fulfilment mutation when its response was lost; keep the case open until read-back agrees |
| Webhook signature, shop or replay mismatch | Check signed metadata and the configured provider subscription | Never disable HMAC or change allowed shop to accept an event; persistent failure pauses intake and escalates to provider support |
| Native renderer, queue or release alarm | Read the exact Actions run and recorded Worker/Lambda pair | Use the paired recovery/rollback workflow; no ad hoc local cloud release or copied receipt |
| Retention, deletion or checksum failure | Read the specific cleanup cursor, source reference and retained blockers | Keep uncertain objects; never delete by age alone or clear remedy/exception state to force cleanup |
| Missing access, MFA or alert delivery | Verify the owner's personal account and documented recipient | Keep purchasing locked until access and notification delivery are demonstrated |

A new exception code without a documented interpretation is a stop condition.
Do not clear it merely to allow an order to progress.

### Recover a false line-identity exception after catalogue refresh

Paid-order validation reads the current catalogue/mapping relationship and artwork
identity in one D1 snapshot. While a new catalogue waits for its mapping, validation
holds and retries; it cannot use old availability or open a permanent line-change
exception. Genuine order, variant, geometry and artwork mismatches remain in review.

For an existing `LINE_IDENTITY_CHANGED` exception confirmed to have been caused by
the refresh overlap, use **Recover a paid-order validation exception** on main in
the protected environment after the fix's native release is verified and unpaused.
Choose `plan` with the exact internal paid-order UUID. The owner workflow rechecks
the live paid Shopify order, signed line identities, current catalogue/mapping,
fraud, Australian address validation and stored artwork object checksum. Plan
records the protected-data read audit but changes no order or provider state.

Review the returned plan hash, source and release, then choose `apply` with that
unchanged hash and UUID. Apply repeats validation and conditionally resolves only
the sole open `LINE_IDENTITY_CHANGED` exception on an unlocked order with no
Printify fulfilment record, active lease or pending/ambiguous management command.
It does not create provider resources or send production work. The normal
reconciliation must validate again and establish Fulfilment Lock before submission.
Read the resulting Printify record and submission timestamp before closing the case.

Order #1003 has a separate owner-only **Recover the existing order 1003 product**
workflow for its recorded `PRINTIFY_PRODUCT_READBACK_FAILED`. The product read
contract permits empty SKUs only on disabled catalogue variants; the enabled
production variant retains its exact nonempty SKU and identity checks. Plan
rechecks the locked paid Shopify order, unchanged delivery address, fraud, current
catalogue/artwork and the recorded provider product. Apply requires the unchanged
reviewed hash and current verified native source. It resumes verification of that
same product and resolves only its sole readback exception. It cannot recreate
media/products, create a fulfilment order, submit production work, or target
another order. Normal materialisation and order submission must finish before
calling the order recovered.

Each first-attempt workflow saves its request before dispatch. If a response is
lost, inspect the exception and order state before any further operation. Do not
rerun the failed workflow, clear other exceptions, or create a replacement order.

## Read-only tools and guarded operations

- Start with `bun run release:status --run RUN_ID` for a release failure. Use the
  recorded journal to resume coordination; never create another journal to
  repeat an uncertain mutation.
- Cloudflare CLI reads must identify personal account
  `{{SHOP:cloudflareAccountId}}`. Use narrow D1 field queries for the actual
  incident; do not export customer tables. Remote migrations and application
  deployment remain in guarded Actions.
- AWS operations use only `node scripts/aws-personal.mjs`, personal account
  `{{SHOP:awsAccountId}}`, profile `personal-dev`, region `ap-southeast-2`. Expired login
  means stop for personal SSO. Never use a default or work credential chain.
- The **Operate bent.shop** workflow supports read-sales-status, pause-sales,
  catalogue/mapping refresh and explicit owner resume. Record the reason and
  verify effective sales status afterwards. A manual resume cannot repair a
  stale catalogue or an unresolved order exception.
- **Product lifecycle** inspects an exact configured-product UUID and applies
  reviewed state transitions. Production needs `WEB_ORIGIN=https://shop.bent.build`
  for authenticated cache invalidation; verify this setting and one saved
  command before a transition batch. Suspend first for an unresolved rights, privacy
  or safety complaint. Owner-only unpublish and retire require the exact
  confirmation; they cannot be reversed. Keep the saved request and receipt.
- Vercel deployment reads must refer to this personal project and the exact
  release URL. Application releases use the guarded workflow and verified
  Worker-first capability check.

## Historical launch data repair

Print jobs prepare geometry-specific artwork when a configured product is created;
they are not paid orders or Printify production submissions. The 5 October repair
is limited to 24 older unpaid source revisions (48 configured products) and the
two missing shirt videos for revision `{{SHOP:resource_02f1c868d95c}}`.
It preserves source bytes, checksums, revision identities, existing videos and
paid-order records, including the retained synthetic canary sources.

Use **Repair launch data incidents** on main in protected Production. Run `plan`
first and review its artifact against the incident cohort. Every original and
existing canonical object must match its recorded checksum. The current snapshot
lookup must use the variant snapshot index rather than scan catalogue history.
Print density is assessed against the unchanged 150 PPI gate. Thirteen old,
unowned families cannot meet it for both products; keep those 26 configurations
suspended through the owner-authenticated Product lifecycle workflow. This
preserves the artwork and complete-family storefront behaviour. Twenty-two
configurations remain eligible for print preparation. Execute only the reviewed `plan_digest`.
The one-shot R2 intent prevents automatic replay after an uncertain response.
An interruption requires inspecting the saved intent and current records before
adding a reviewed recovery; do not rerun execution or reset the marker.

Keep Sales Pause enabled while repairing. Run `verify` after background work
settles; require all 22 eligible configurations to pass purchase readiness,
all 26 suspended configurations to remain unavailable with their inactive
outbox work closed, all four incident videos ready and publicly accessible,
and the paid-order digest unchanged. An inactive job being closed does not
mean a print asset was generated; it follows the executor's existing inactive
completion semantics. Then use **Operate
bent.shop** to resume sales and verify effective sales status. This data operation
does not deploy or requalify a different application/renderer pair.

## Launch monitoring and tracing

The owner owns application alerts as well as provider exceptions. Cloudflare's
production API and print executor use the existing owner email destination.
PostHog insight emails use that provider's existing owner account, approved on
5 October 2026. Both PostHog launch alerts are enabled with hourly checks of a
rolling two-hour SQL count. The overlapping lookback covers hour boundaries and
check delays; it does not guarantee immediate notification.
Never send portraits, order capabilities, addresses or raw provider errors in
notifications.

| Signal | Where to investigate | Alert and interpretation |
| --- | --- | --- |
| Browser exception | PostHog Error Tracking, matching release and masked replay | Hourly check alerts on any exception in the rolling previous two hours. Zero is not proof that capture works |
| Handled HTTP failure | PostHog `storefront_failure`, operation/status/code/requestId | Hourly check alerts above two 5xx failures in the rolling previous two hours; review repeated network and cart rejections separately. Expected 4xx need diagnosis, not automatic paging |
| API request, webhook or scheduled failure | Cloudflare Workers Logs/Issues for `forever-tee-api` | First occurrence and recurrence after one hour of quiet, scoped to Production |
| Print execution failure | Cloudflare Workers Logs/Issues for `forever-tee-print-executor-production` | Same occurrence/recurrence rules; preserve retry and lease recovery |
| Public page availability | API records with operation `storefront_availability` | Bounded HEAD probes of `/` and `/create` every 15 minutes; failed status/network checks enter API Issues |
| Cloudflare service outage | Provider incident notification and [Cloudflare status](https://www.cloudflarestatus.com/) | Owner email for major/critical incidents affecting Workers, D1, Queues, R2 or Workers Observability |
| Checkout or cart admission failure | Vercel production runtime logs | Search `[bent.shop checkout]` or `[bent.shop cart]`, request ID and stage. A deliberate Sales Pause is a warning; a failed dependency is an error |
| Renderer health, throttles, DLQ or readiness | Exact guarded native Actions run, Lambda/CloudWatch alarms and D1 state | Runtime alarms remain separate. Native readiness checks are manual: the former five-minute Actions schedule was removed at the owner's request. Verify the subscription and run the guarded monitor during attended launch |

Cloudflare policy `cac0755be2b745268d6ffc333e2feb88` and four service automations
were created on 5 October 2026. Its test API accepted a notification, and the
matching policy email reached the owner's inbox at 12:21 Brisbane time. This was
the provider's sample notification, not an application failure. Collection requires the reviewed Worker configuration
release with Issues enabled. Policies alone do not prove that failures are detected.
Occurrence thresholds fire once at the crossing; recurrence means a failure after
an hour of inactivity, not repeated emails throughout a continuing outage.
Provider incident policy `42932df7a59140129615c1727057b6aa` is enabled for those
five components and major/critical impact. This is independent of the API probe;
it reports provider-declared incidents, not every application outage.

Production browser insight:
[exceptions](https://us.posthog.com/project/556833/insights/tVYdJ5vY).
Handled failure insight:
[service failures](https://us.posthog.com/project/556833/insights/hZSAtH17).
Both filter stable production hosts. Their SQL queries count events with
`timestamp >= now() - INTERVAL 2 HOUR`; the service query also requires status
500–599. Each alert evaluates the single named count column using `last_row`.
Do not replace this with an hourly check of only the current clock-hour bucket:
an error after one check can fall outside that bucket before the next check.
Verify the saved insight's output and the alert's configured column together.
`storefront_failure` requires the instrumentation release; rows before that
release are not evidence of coverage.
Alert IDs are `01a109f2-510f-0000-d38f-ff3464b0d658` (exceptions) and
`01a109f2-553e-0000-ada5-b8397bc69dff` (service failures). Configuration readback
does not prove ingestion, evaluation or PostHog email delivery.

For an incident:

1. Record UTC time, environment, exact web deployment, Worker version and native
   release pair before changing anything. Keep the initial evidence privately.
2. From the browser failure read its request ID, operation, status and safe code.
   On design/upload requests the same ID appears in Vercel BFF records and Worker
   records. Use attemptId/designId only in the private creation trace investigation.
3. Search Vercel production logs by request ID and bounded time window. Search
   Cloudflare logs by that ID plus Worker name; inspect the issue occurrence and
   structured duration records. Automatic platform traces remain disabled until
   their captured metadata passes a separate privacy review. Queue/cron records use operation/executionId;
   renderer and print records use their persisted job IDs to continue the trace.
4. Inspect the adjacent provider outcome or recorded job state. Keep an uncertain
   mutation stopped. A successful HTTP response, queue acknowledgement, probe or
   maintenance pass does not prove fulfilment or a financial outcome.
5. Reproduce in fixtures or Preview, run the relevant regression and follow the
   guarded paired release/rollback process. Confirm the new deployed identity and
   actual recovery before resolving the issue.

Export narrow incident evidence promptly. Vercel currently has no log drain;
its [runtime log retention](https://vercel.com/docs/logs/runtime) depends on plan
and is one day on Pro. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
retain at most seven days, and provider limits can reduce capture after quota
exhaustion. Existing renderer infrastructure requests 14 days of CloudWatch logs;
verify the live log group rather than assuming the infrastructure declaration is
current. A durable drain needs its own approved private destination and retention
policy. Provider dashboards alone are not an incident archive.

Before public launch, record each result against the exact deployed pair:

- [ ] Verify Issues, query redaction, persisted application logs, disabled
  invocation logs and disabled automatic traces on the live API
  and print executor after guarded deployment. Trigger a controlled Preview
  failure; read its occurrence and automation run. Do not install a public error
  trigger or deliberately fail a real paid-order mutation.
- [ ] Confirm receipt of the test Cloudflare email and an actual controlled issue
  notification. Repeat the notification test after recipient changes.
- [ ] Confirm active PostHog alert thresholds/recipients, ingestion of a
  redacted browser exception and handled failure, and source-map resolution to
  the deployed source. A console-created stack alone does not prove symbolication
  of the shipped bundle.
- [ ] Read back a design request ID in browser, Vercel and Worker records. Verify
  private Manage order never captures browser analytics, and inspect diagnostic
  samples for query strings, capabilities, raw errors and customer fields.
  Confirm new upload URLs have a fixed path and no capability in retained
  platform metadata. An obsolete path grant must expire with an upload retry;
  no upload or customer-data processing may run for that request.
  Verify uncaught issue samples contain the sanitized diagnostic reference and
  safe source locations, without the original error message or nested cause.
- [ ] Verify the public availability schedule runs, its failed probe signal can
  reach the owner, and the existing native alarms/subscription are active. Verify
  the guarded manual readiness monitor against the current pair; do not restore
  the costly Actions schedule. The API-hosted probe cannot detect a total Cloudflare account outage;
  use provider incident notifications and attended launch monitoring for that gap.
- [ ] Confirm a private incident evidence archive and owner coverage while public
  orders are accepted. Keep purchasing locked if notification delivery or access
  remains uncertain.

## Split shipments, refunds and remedies

Treat each package separately. Match the provider shipment's exact lines,
quantities, tracking number and carrier to the Shopify fulfilment. A delivered
first package does not mark every item delivered. Keep unmatched or duplicate
shipments in review; never fulfil remaining quantities by assumption.

During the one-hour hold, the customer's private page may correct an Australian
address repeatedly or request whole-order cancellation. After Fulfilment Lock,
ask Printify whether a change is still possible before promising it. Do not edit
Shopify and assume an already-created Printify order will change.

For a complaint, record the customer's order number and necessary evidence in
the private support case. Apply `BS_REMEDY_OPEN` promptly. Determine the affected
item and requested outcome, inspect the provider evidence, and explain the next
step. Do not demand extra portraits or identity documents when the order record
answers the question. Existing consumer rights remain in the published returns
policy. Seek appropriate professional advice for a legal dispute or unclear
obligation rather than inventing a new policy in a reply.

Before a manual refund, inspect all prior refunds and any self-service command.
Confirm the intended total and original payment method. Request the refund once,
then verify the resulting financial status and actual amount. Keep the pending
tag until confirmed. Reconcile any Printify credit or replacement invoice in the
owner's manual cost records without double-counting a payout deduction. Close a
remedy only after the agreed customer outcome, including replacement delivery
where relevant, is recorded.

## Qualification and first public order

Both checklists are gated by the owner's explicit purchase authorization.
They have not been performed while purchasing is locked.

1. Confirm personal access/MFA, support sending, policy and notification links,
   exact prices and delivery threshold, provider currency and manual cost sheet.
2. For qualification, the owner places the approved two-item order through the
   real creation, product, cart and Shopify checkout journey. Do not use a
   provider sample shortcut or create a substitute order through an API.
3. Verify payment, the confirmation's private link and exact deadline, HMAC
   receipt, hold binding, fraud/address validation and immutable line identities.
4. Verify Fulfilment Lock happens only after the deadline and preserves the
   final address. Read back the exact Printify media, product and order before
   production. Confirm no duplicated jobs or charges.
5. Monitor each shipment and Shopify tracking notification through delivery.
   Inspect both physical items, colour, placement, edges, print quality and
   identifiers. Record the actual invoice, GST charged to the business, delivery,
   processing fees, payout and any discrepancy in private financial records.
6. The owner accepts the physical qualification items before public launch.
   Monitor the first public order with the same payment-through-delivery checks,
   while remaining available to pause intake if anything is uncertain.

## Access and tabletop evidence

The owner approved the six [customer email templates](customer-email-templates.md)
through PushWard on 5 September 2026. This approval covers their wording;
outbound delivery verification and the operator exercise below remain pending.

The owner must confirm MFA, recovery ownership and emergency access for Shopify,
GitHub, Cloudflare, Vercel, Printify, OpenAI and the support mailbox. Do not store
recovery codes in this repository. Confirm minimum staff access and the actual
alert recipient, then record a dated reference to the private evidence.

The implementation fixtures exercised duplicate paid events, overlapping order
changes, lost provider acknowledgements, refund read-back and split shipments.
They are technical evidence, not a completed operator tabletop. Before public
launch the owner should walk through: a cancellation timeout, an invalid final
address, a missing second shipment, a rights complaint after production starts,
and a failed renderer release. For each, record the pause decision, exact read,
forbidden retry, customer response and resume evidence. Unresolved actions stay
open or need explicit owner acceptance with an expiry. Owner access confirmation
and this tabletop are pending; no completion has been inferred.

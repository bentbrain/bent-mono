# UI and UX principles

This document records the product's agreed interface constraints. It is deliberately stricter than a collection of general design tips. Agents and contributors must use it when planning, implementing, or reviewing customer-facing changes.

## Decision authority

### Use `main` as the design baseline

The customer-facing interface on `main` at commit `f47a02a` is the current design baseline. Later merged changes may advance that baseline when the product owner has intentionally approved their design effect.

Preview deployments, concept routes, screenshots, task history, and unmerged branches are reference material only. Their existence does not make their UI or UX decisions part of bent.shop's design language. An agent must not copy an experimental pattern into product code unless the product owner explicitly adopts it.

### Preserve the established design language

The existing bent.shop interface outranks generic UX research, design trends, component-library examples, and an agent's preferred solution.

Research may help solve a stated problem within the established design language. It does not authorize a new visual language, page structure, navigation model, or interaction pattern. Those changes require the product owner's explicit approval before implementation.

Local measurements do not override this rule. Keeping controls above the fold, reducing taps, passing automated tests, or improving an isolated accessibility metric cannot justify changing the product's design principles or journey structure.

## Design ethos

### Feel like a creative instrument

bent.shop is a creative instrument, not a conventional ecommerce catalogue or a professional design tool. The interface is quiet, direct, and precise. Its playfulness comes from seeing a portrait become a physical product, not from decorative UI, novelty interactions, or marketing copy.

The customer's artwork and the product mockup are the expressive centre of the experience. Controls should be obvious, responsive, and visually restrained so they support the result instead of competing with it.

### Give each stage a clear hierarchy

Each stage has one dominant object and a clear action hierarchy. Creation centres the portrait or canvas. The product page centres the current product preview and purchase decision. The cart centres the selected items and checkout readiness.

The primary action advances the current journey. Important secondary actions remain exposed and visually deliberate. On a product page, Add to cart advances the purchase journey, while Make your own is a prominent secondary route into creation. Do not bury it as an incidental link or duplicate the primary action in several places.

### Start with the best result

bent.shop should do as much creative work as it can automatically. The first result should look finished, especially the recursive placement of the customer's portrait. The ideal customer accepts that result without making an adjustment.

Customers can adjust the result when needed. This is correction of a strong default, not a professional editing workflow. Prefer direct manipulation and a small set of relevant controls. Do not add undo, history, or similar editor machinery to the design canvas without explicit approval.

### Make every control earn its place

Do not surface a control unless the customer genuinely needs it. Controls are excluded by default. If bent.shop can infer a safe choice or complete the work itself, it should do so without asking.

A visible control must support a required customer decision, correction of a result the system cannot always infer, or an intentional route such as Share or Make your own. Never expose internal settings, implementation choices, alternate modes, or customisation merely because the system supports them.

### Keep the journey moving

Each interaction should change the visible object, make a clear choice, or advance the customer through the journey. Avoid setup screens, explanatory modals, confirmation steps, and tutorial UI unless they prevent a real mistake or satisfy a legal requirement. Teach through the controls and the visible result.

Every touch must receive an immediate visible response. If the requested work cannot finish immediately, acknowledge the action at once and show its progress without making the customer wonder whether the touch registered.

### Move forward, but preserve recovery

The designed journey moves forward. Do not surface Back, Edit, or return-to-previous-step controls. Each stage should make its next step clear rather than encouraging routine movement between earlier stages.

Preserve enough state to recover from refreshes, failures, and accidental browser navigation without losing completed creative work. Recovery exists for resilience, not as an editing model.

### Use optimistic feedback before commitment

Reflect reversible, low-risk actions immediately while the server completes them in the background. Cart updates may be optimistic. Block only the dependent or conflicting parts of the interface while work remains pending.

Commitment boundaries require confirmed state. Checkout must remain unavailable until cart mutations and the product data required for purchase are confirmed safe. If an optimistic action fails, reconcile the visible state, explain the failure in place, and preserve the customer's design and valid choices.

On 17 September 2026 the owner approved allowing Add to cart while print artwork
is still being prepared. Persist the selected product and show its preparation
status in the cart. Keep quantity, removal and shopping available; block checkout
until the required artwork is ready. A refresh must retain the pending item, and
readiness failures must offer retry without requiring the design to be recreated.

On 28 September 2026 the owner extended this to full-resolution source
preparation: Continue freezes the screened, editable preview and opens the
product page immediately once settings and the source-resolution check pass.
Customers may select products and add them to the cart while preparation runs
in the background. Only checkout waits for verified print artwork.

### Reveal readiness progressively

Outside the protected creative animations, show the stable product or artwork frame as soon as possible. Fill in dependent data and enable actions as they become safe instead of holding the entire screen.

Reserve layout space so arriving content does not make the interface jump. A loading state should resemble the content it is preparing. Use a full-screen loading state only when the entire task genuinely depends on that work.

### Write plainly

Use terse, matter-of-fact interface copy with a little dry personality where it fits. Avoid ecommerce hype, congratulatory chatter, long instructions, anthropomorphised processing, and technical language.

Buttons name the action they perform. Errors state what happened, what remains safe, and what the customer can do next.

### Persuade with the product

bent.shop persuades through the customer's created product, not manufactured urgency. Do not use fake scarcity, countdowns, interruptive popups, preselected sizes, guilt copy, or visual tricks that push checkout.

State real availability, price, delivery information, and purchase constraints plainly. A conversion improvement should remove genuine friction or uncertainty.

### Make sensitive actions intentional

Ask for camera access only after the customer chooses to take a photo. Make capture and sharing explicit. Never upload, publish, or share a portrait because of an ambiguous gesture.

Explain a sensitive action at the moment it matters, in plain language. Do not front-load the journey with legal or technical copy that obscures the task.

## Visual language

bent.shop uses a cobalt-blue interface against white, with a black background in dark mode. Monospace type, square corners, thin visible borders, flat fills, and strong colour inversion give the interface its identity. Product and customer imagery carries the emotional weight, so the surrounding UI stays visually restrained.

Motion should explain an action, transition, or state change. It should not decorate an otherwise static interface.

Two established motion moments are part of the design baseline:

- the background-removal sequence over the captured photo
- the processed-cutout reveal into the design canvas

Retain their intent and visual character. They mark the app's main creative transformation. They do not authorize decorative animation elsewhere, and their reduced-motion behaviour remains mandatory.

These are defaults, not incidental implementation choices. Contributors may refine spacing and responsive behaviour while preserving them. Rounded cards, shadows, soft neutral palettes, conventional ecommerce styling, decorative animation, or another visual system require the product owner's explicit approval.

### Use the project's interaction primitives

Prefer the project's shadcn components and Base UI primitives for new standard interactions whenever an appropriate component exists. Do not hand-roll accessibility and interaction behaviour unnecessarily.

The presence of a library component does not authorize a new UX pattern, and its default appearance does not authorize a new visual style. Start with an approved bent.shop pattern, then adapt the primitive to the project's visual language.

## Interaction model

### Keep primary choices and actions exposed

Customers should be able to see and use the primary controls for the current task without opening another interface. On the product page, this includes colour, size, Add to cart, Share, and Make your own.

Accordions, drawers, carousels, sticky docks, wizard steps, and automatic collapsing must not hide, replace, or reorder primary choices and actions unless the product owner explicitly approves that interaction model. Disclosures remain appropriate for supporting information such as garment details and the size guide.

### Feel crisp and deterministic

Controls acknowledge touch through immediate inversion or another clear state change. Direct manipulation follows the customer's touch without lag or decorative easing. Motion is short and functional.

Avoid springy spectacle, scroll-jacking, hidden gestures, and interactions whose result requires the customer to guess what the interface will do.

## Customer journeys

bent.shop supports two intentional journeys.

The Creation journey is:

`Featured Design -> create -> camera or image upload -> editor -> product page with shirt and tote choices -> cart -> Shopify checkout`

The Direct purchase journey is:

`Featured Design with shirt and tote choices -> cart -> Shopify checkout`

A customer may use both journeys in one session. For example, they may add one of the Featured Design's products to the cart, choose Make your own, create another product, and add that product to the same cart. The cart is where the results of the journeys meet.

Customers cross between the journeys only through explicit actions. Within the Creation journey, the stage order remains stable. Contributors must not add intermediate screens, skip stages, merge stage responsibilities, or introduce automatic redirects between arbitrary stages without the product owner's explicit approval.

### Camera capture and photo review

The create route also offers Upload image alongside Open camera. Both require
the existing content declaration and share photo review, background removal,
and the editor. Uploaded photos use Choose another in place of Retake.
Creation remains phone-only. JPEG, PNG and WebP uploads may be up to 20 MB,
50 megapixels and 12,000 pixels per side. Preserve source pixel dimensions
through preparation; encode smaller display previews separately. Camera capture
also preserves its frame dimensions. The 150 PPI print minimum remains unchanged.

On 7 September 2026 the owner approved the camera's top-left timer control,
cycling through `3s`, `5s` and `10s`, with a lowercase `s` and a 3-second default.
The captured photo stays in the camera's full-photo frame with Retake and Confirm
actions. Background processing starts during this review. Confirm shows the
existing processing sequence only if needed, then the processed-cutout reveal;
if the cutout is already ready, Confirm starts the reveal directly. Retake
discards the current result and preserves the selected timer duration.

The empty cart's Make your own action opens `/create` and closes the cart overlay.

### Saved designs

Issue #397 supersedes the earlier landing selection and saved-grid placement. The
root is a three-column square image grid containing featured products followed
by the current visitor's saved designs, with a final plus tile linking to
`/create`. The create page keeps its camera prompt without a product grid.
Featured products have stable `/featured/<product-id>` pages using the shared
purchase component. Remove the die and random selection. Existing numbered
homepage product links redirect with their selections intact. Saved designs
retain session ownership and explicit pagination; deleting one returns to the
root grid. This does not authorize a public feed of customer designs.

Issue #285 adds a grid of completed designs beneath the existing `/create` prompt, separated by a dotted divider. Each square shows a product mockup and links directly to its product page. The owner approved five squares per row on mobile. The grid uses the current browser's anonymous ownership session; it does not transfer designs between devices.

Continue ends editing. Browser Back from the newly created product returns to `/create`, and completed editor links also return there. Customers cannot reopen or revise a completed design.

On 22 September 2026 the owner approved two checkbox controls below the design
canvas in a borderless section: Background, unchecked by default, and Effect,
checked by default. Selecting Background restores the photo's background;
Effect controls the recursive pattern. Their choices survive refresh and apply
to the completed products. While the customer
moves the design, both product previews use 80% opacity and return to full opacity
when the gesture ends. A design without recursion keeps its product images but
does not generate or display a carousel video.

The editor limits photo zoom using the stored artwork resolution and the stricter
accepted print area across the shirt and tote, preserving the 150 PPI minimum.
The current M shirt area also covers the larger shirt sizes. Continue creates
both products together; a quality failure must not silently create only one.

On 9 September 2026 the owner approved loading saved designs in batches of 40,
with an explicit Load more button beneath the existing grid. Keep the five-column
phone grid and direct product links. Preserve loaded tiles while another page
loads or fails, and allow retry without discarding them.

An owned product page includes Delete centred immediately below the product lockup, outside its border, using the Size guide link font size with regular weight. Issue #295 shortens the original Delete design label. It opens a confirmation alert dialog. Confirming removes the design and its product pages, then returns to `/create`. Existing orders remain valid. Internal purchase snapshots and assets needed for those orders are retained; unused artwork, previews, print assets and story videos are cleaned up.

## Product pages

### Featured design selection

On 5 September 2026 the owner approved issue #291's up-to-six fixed featured
design slots and blue-and-white pixel die. Unnumbered homepage visits choose a
configured slot randomly; shared links retain that slot. The die shuffles to
another configured slot with a brief changing-face animation while loading.
The owner later specified a flat cobalt body, white pixel dots, stepped corners,
no outer button border, and slower 180 ms face changes with a 900 ms minimum
roll. After a local six-face and storefront review, the owner approved smaller,
inset dots with more internal blue padding. Reduced motion keeps the face still.
Shirt/tote choices retain the shared
product-page system. Slot numbers remain attached to their configured products.

### Manage order

On 5 September 2026 the owner approved issue #260's account-free Manage order
page for delivery-address corrections and whole-order cancellation during the
one-hour Production Hold, using the existing bent.shop visual style.
Purchasing remains locked until a separate explicit instruction to reopen it.

### Use one product-page system

On 5 September 2026 the owner requested left-aligned shirt/tote buttons on
mobile. On desktop, those buttons sit at the top of the right-hand product
details column beside the featured-design die. The product image starts at the
same top edge instead of leaving a full-width selector row above it. This
alignment applies to the shared product-page system.

Every Base Product uses the same product-page hierarchy and interaction model. A shirt and tote may have different mockups, variants, product details, sizing information, availability, and price. They must not grow separate page layouts or separate cart behaviour.

Switching Base Products preserves the customer's design and clearly identifies the selected product. Adding another Base Product must extend the same purchase journey rather than sending the customer through a divergent page.

The Featured Design and customer-created designs use the same underlying purchase component. The landing page may frame the Featured Design differently, but it must not fork the product selector, variants, purchase actions, sharing, loading states, or cart feedback into a second implementation.

### Make switching immediate

The product page keeps an always-visible, one-action selector for switching between the shirt and tote. Once the page is ready, switching should feel immediate and must not trigger full-page navigation or an intermediate loading screen.

The artwork remains unchanged across the switch. Each Base Product remembers its last valid variant choices during the visit. Adding one product keeps the customer on the product page so they can switch and add the other without recreating the design or repeating earlier choices. The cart keeps each selected Base Product as a distinct line item.

Keep the page frame stable while product-specific options change. The selector, main preview, price area, and purchase actions remain spatially consistent. Switching must not reset scroll, make the page jump, or move the control the customer just used.

### Keep the preview truthful

The product preview must correspond to the current artwork, Base Product, colour, and placement. Prefer an accurate, stable mockup over a more dramatic presentation that could misrepresent the product. Show the current price, availability, and any purchase-blocking save state before checkout.

## Responsive priorities

### Design for the customer's input device

Creation remains mobile-only because its camera and touch canvas are part of the intended experience. Do not add a desktop upload flow or mouse-based editor.

The Featured Design, product pages, and cart keep consistent actions, terminology, journey logic, and product behaviour across devices. Their layout and interaction should adapt to the device rather than merely resize. Touch needs generous targets, direct gestures, and no hover dependency. Mouse and trackpad interactions may use precise pointer behaviour and useful hover states. Keyboard interaction needs a logical focus order and only discoverable shortcuts. Composition and information density may change to suit the viewport.

### Treat above the fold as a goal

On common mobile viewports, show the product image, selected product, price, variant choices, and Add to cart as early as practical. This is a priority, not a requirement to fit every action into one viewport.

Allow natural scrolling when the alternative would shrink touch targets, hide controls, collapse primary sections, or change the established visual hierarchy. An above-the-fold measurement cannot overrule the visual language or interaction principles in this document.

## Change authority

### Separate repairs from design changes

Contributors may implement repairs that preserve the established hierarchy and patterns. This includes fixing overflow, broken states, spacing inconsistencies, accessibility defects, and responsive bugs.

The following changes require the product owner's explicit approval before product code changes:

- moving, hiding, replacing, or reordering primary controls
- changing page or customer-journey structure
- introducing a new interaction pattern such as sticky UI, an accordion, a drawer, or a carousel
- replacing a shared component in a way that changes its customer-facing behaviour
- changing the visual language

A request to fix, improve, modernise, simplify, or make an interface mobile-friendly does not authorize these design changes. If a repair appears to require one, stop and present the trade-off instead of expanding the task.

### Isolate and approve intentional design changes

Develop intentional design changes outside the production journey first. Show the proposal against the current baseline at representative mobile and desktop sizes, then obtain explicit approval for its structure and interaction before changing product code.

Implement the approved proposal without adding adjacent improvements. If technical constraints require a visible deviation, return for approval before proceeding. A concept route, screenshot, prototype, Preview deployment, or earlier task remains a proposal until the product owner explicitly adopts it.

## Verification

Automated tests are necessary but do not prove that a customer-facing change preserves the design. Every UI change also requires visual checks on a representative phone and desktop, plus an end-to-end check of the affected journey in context.

The handoff must describe the visible change and confirm that adjacent screens and states did not drift. An approved structural change must include a comparison with the design baseline. Verification must exercise the screen customers actually reach, not a concept route or isolated component standing in for it.

## Accessibility

Use semantic controls, support keyboard operation, show visible focus, provide adequate touch targets, respect reduced-motion preferences, and never rely on colour alone to communicate state.

Accessibility repairs must preserve the established visual language. If an accessibility need genuinely conflicts with an approved design decision, present the conflict and options to the product owner. Do not quietly replace the interface with a component library's default design.


### Account-free order management

For issue #260 the owner approved a Manage order page for Australian delivery
address corrections and whole-order cancellation during the original one-hour
hold. The order reference and exact deadline precede the exposed address form.
Cancellation is separate and asks for confirmation before requesting a full
refund. The page uses the existing blue/white monospace style, square borders
and buttons. Expired links lead to the established support address. It has no
account sign-in, order history, marketing, or new navigation step.

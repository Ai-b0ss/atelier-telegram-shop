# Atelier Telegram Mini App — research and launch plan (2026-11-01)

Scope: physical garments and custom tailoring **without integrated checkout payments**. The buyer submits an order/request, an atelier manager confirms availability, shipping and final price in Telegram. No crypto/payment provider is in scope for v1. Do not activate `DEMO_MODE=0` or `STORE_READY=1` in a code-only PR.

## Verified baseline

- Public Worker /health responds with `ok:true`, `mode:demo`, `database:true`.
- Public /api/catalog currently lists three fictional products, four variants and **zero available product photos**. These are not real seller inventory.
- A Telegram webhook and Cloudflare D1 already exist; there is no need to migrate to React/Postgres/paid hosting solely to make the site attractive.
- The current editorial CSS is applied on /app. Design should be judged with actual garment photos and real product descriptions before considering a redesign complete.
- Our API and Bot share D1. Keep the database authoritative for prices, quantities, reservations and order status: browser localStorage must not become a source of truth.

## Repositories reviewed — reuse only appropriate parts

| Reference | What to learn | Reuse / license decision |
|---|---|---|
| https://github.com/telegram-mini-apps-dev/vanilla-js-boilerplate | Telegram launch, plain JavaScript, theme/back button integration | MIT. Small snippets may be adapted with license notice when copied. |
| https://github.com/IvanTereshin/tma-shop | initData verification, cart idempotency, typed API contracts and tests | MIT, but React/Hono/Postgres should **not** replace our already working stack. |
| https://github.com/unusdon/nova-store-telegram-mini-app | Product galleries, sorting/filter controls, store/admin information architecture | **Source-available, not MIT/open-source.** Source permits running own store but restricts template redistribution; avoid copy/pasting wholesale UI and preserve license. Demo localStorage is not production stock control. |
| https://github.com/22Warm-XD/telegram-store-manager | Fashion-specific flows: sizes, 1–5 product photos, SOLD status, channel-to-catalog import | License not confirmed in repository root at the time of audit; treat as **reference only**, do not copy code. |
| https://github.com/JumpCodeFrog/telegram-shop-bot | Vanilla Mini App and admin catalog, payment-free elements only | MIT; payment adapters/crypto features out of v1 scope. |
| https://github.com/mustaphaukizuru/ukistore | Responsive filtering/drawer/accessibility practices | Project claims MIT in README, but license file not verified; use UX ideas only until rights verified. |

## External failure reports worth turning into tests

- Official Telegram Mini Apps API and guidelines: https://core.telegram.org/bots/webapps. Validate `initData` server-side, follow safe-area/theme changes, use native BackButton.
- Real iOS issue: https://github.com/TelegramMessenger/Telegram-iOS/issues/1296 — keyboard and Telegram viewport height disagree. Never assume the bottom of the visible window is stable while the keyboard is open.
- 2026 iOS issue: https://github.com/TelegramMessenger/Telegram-iOS/issues/2235 — occasionally opening a keyboard collapses WebView viewport to 1px. Check recovery with the keyboard dismissed; do not make a form depend on magic fixed screen heights.
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/ — free Time Travel is seven days, not an independent portable off-device backup. Local SQLite tests cannot replace an isolated Cloudflare D1 restore drill.
- Telegram physical-goods payment docs: https://core.telegram.org/bots/payments. Stars rules for digital goods do **not** oblige the seller to add in-app payments for physical apparel. We intentionally leave all payment integrations disabled.

## Design direction before photos arrive

Compare *on the same three real product photos*:
1. **Editorial Atelier** (provisional preferred): warm off-white #F6F2EC; ink #242321; restrained oxblood #733C46; high-quality serif only for major editorial titles and a single readable sans for all controls; portrait photography, unobtrusive category chips.
2. **Minimal Commerce**: white / charcoal, narrower typography system, 2-column product cards and a full-width sticky purchase action on the product detail.
3. **Workshop / Natural Materials**: stone, olive and natural textures; emphasize fabric, craft, stitching close-ups and the bespoke service. Avoid fake texture overlays or unreadable muted text.

These are *original design directions*, not copied external assets. Useful mobile references for composition, not to copy: https://www.hugoandmarie.com/projects/fforme/ and https://studiosmall.com/project/erdem/ and https://www.behance.net/gallery/208219235/WEB-DESIGN-BRANDING-FOR-LYANG .

Do not present the current sample clothing as real inventory. Use a neutral placeholder if a photo is unavailable; use the seller's licensed/owned images only.

## Required product intake data

For each real item supplied by the owner/atelier: exact title, description, garment category, photographs (front/back/details, usage rights), size chart and size-specific stock, available colors, price in RUB, unique SKU per variation, production lead time where relevant, care/material details, shipping availability and whether handmade/preorder. Cost price is admin-only and optional for sales flow but needed for profit reporting. Disallow negative stock, duplicate SKUs, stale photo references, empty variants, or product activation with zero valid images if the launch policy requires images.

**Known gap:** the current `products.photo_file_id` stores a single product image. Multi-photo gallery requires additive D1 schema/API change, migration and new integration tests; do not fake this via links to strangers' images.

## Acceptance matrix for no-payment v1

| ID | Scenario / failure injection | Expected behavior |
|---|---|---|
| A01 | Anonymous Chrome / forged `initData` opens admin | No PII or admin writes; correct access denial |
| A02 | Buyer A and B buy the last single item simultaneously | Exactly one order reserves stock; other gets recoverable out-of-stock error |
| A03 | User double-taps checkout, retries same request ID after network timeout | Exactly one order, stable order number, no duplicate stock decrement |
| A04 | One cart item archived or its price changed | Atomic checkout rejection, all items preserved; never silently omit or overcharge |
| A05 | Telegram Bot API fails after D1 order commit | Order survives; admin/customer delivery retried from durable outbox with an explicit at-least-once guarantee |
| A06 | User cancels before shipment, then repeats cancellation | Reserved stock returned exactly once |
| A07 | Shipped order cancelled before physically received | No artificial restock; only confirmed return receipt restocks |
| A08 | Custom tailoring quote changed after customer opens an old button | Stale quote rejected; new accepted quote has the correct revision |
| A09 | Admin changes size, color, stock or photo while customer browses | Refresh reconciles actual availability; no stale checkout |
| A10 | iOS and Android Telegram WebView, opened keyboard, back button, tall form, light/dark themes | No obscured submit control, no horizontal overflow, native BackButton returns to catalog |
| A11 | `initData` older than 600s during a long edit | Clear session-expired / reopen-in-Telegram guidance; never accept invalid auth |
| A12 | Network drops during cart update, Telegram sends duplicate webhook | Recoverable UI, no duplicate mutation or duplicate order |
| A13 | Damaged/partial D1 backup or missing trigger, offline restore | Validation fails; isolated full restore succeeds only for correct backup |
| A14 | No buyer-provided measurements or delivery option, empty cart | Form validation and meaningful feedback before any write |
| A15 | Product photo absent, Telegram file expired/unavailable or image too big | Stable aspect ratio, labelled fallback; no broken image icon or leaked bot token |

## Work sequencing (not a calendar promise)

**P0 — buyer safety and acceptance:** Resolve #18 durable notification outbox/retries; #17 independent portable backup plus restore drill; verify launch guard and all order/stock invariants; confirm no-payment terminology in every screen.

**P1 — real catalogue and design:** Import owner photos/data on a private staging catalogue, implement multi-image product gallery if at least two photos per item, complete product details and size charts, refine Editorial Atelier vs alternatives using one consistent sample, test iOS and Android inside Telegram. Avoid copying source-available templates wholesale.

**P1 — release gate:** A separate real buyer Telegram account and admin complete catalogue order, cancellation and custom tailoring, including offline/retries. Verify actual webhook/D1 health and irreversible backup restore on a separate test D1. Record successful evidence; then and only then discuss enabling real orders. Payment provider remains disabled.

**P2 — later enhancements:** Search, favorites, status timeline, import from existing channels, discounts, crypto, analytics improvements only after real garments and core checkout are reliable.

## Important limits

Passing unit/CI tests does not guarantee zero defects, real iOS compatibility, or successful D1 disaster recovery. Do not claim the site is production-ready until A01–A15 and all business/legal prerequisites are supported by evidence. Do not include customer names, measurements, phone numbers, bot tokens or live backups in PRs and screenshots.

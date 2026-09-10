# Checkout, legacy calendar and staging audit

Date: 2026-09-09. Working branch: `fix/fechamento-backend-2026-09-09`.
This report supplements `BACKEND-CLOSURE-2026-09-09.md`; existing uncommitted
changes were preserved. No commit, push, deployment or production data mutation
was performed. The latest authorization to deploy is conditional on all checks
passing; that condition is NOT met.

Subsequent user clarification: no separate staging/test Shopify store is confirmed;
continue only local auditing and read-only inspection of identified production.
No external changes are authorized. Do not create environments, change Shopify
or Railway settings, push or deploy based on this report.

## Proven findings and changes

1. The Next cart retried POST /holds after a successful HOLD and failed checkout.
   Idempotent HOLD replay deliberately does not return its secret a second time.
   A stock recheck could also reject the customer's own occupied unit. The cart
   now keeps the successful HOLD credential for the unchanged attempt and retries
   only POST /checkout. Changed quantity/date/Sunday choice starts a separate
   intent; repeated clicks and stale results cannot create parallel redirects.
   The backend remains the authority. Browser state never confirms a reservation.
2. Already-expired reservations returned 409, unlike lazy expiration's 410.
   Checkout now returns 410 consistently after validating possession of the HOLD
   token. Only authoritative expiration resets the client's cached attempt.
3. The shopping-cart Storefront projection unnecessarily exposed checkoutUrl
   before HOLD. Removed that unused field. This is NOT a server-side restriction
   on Shopify checkout: a client can still call the public Storefront API.
4. Railway's checked-in command referenced missing `dist/main.js`. It now uses
   the package start script (`node dist/src/main.js`). Migration and /health
   settings are preserved. The existing remote override already used the correct
   entrypoint, so this was a configuration-as-code/future-environment defect.
5. A checkout error logged the complete Storefront cart ID, which can contain a
   cart access key. Removed it; the reservation ID remains for correlation.
6. The legacy calendar fabricated availability in demo mode, used old local
   duration/quantity rules and POSTed /cart/add.js without HOLD or signed binding.
   Replaced its local JavaScript with an inert, localized retirement notice.
   It performs no network calls, creates no dates and never enables submission,
   including after theme-editor reloads. No historical database data was removed.
   This local change has NOT been released to Shopify.
7. Shopify webhooks authenticated the app secret but did not bind the event to
   this environment's configured shop. The controller now requires and validates
   `X-Shopify-Shop-Domain` after HMAC verification. Missing/wrong-shop requests
   fail before persistence; regression coverage uses the real HTTP controller.
8. Concurrent first use could race on the unique `stores.shopify_domain` key when
   HOLD, manual reservation or webhook transactions initialized the same store.
   A shared idempotent initializer now creates once, reloads the persisted row and
   fails closed if domain or currency diverges. Eight concurrent transactions are
   covered by an integration test.
9. The checked-in Shopify configs subscribed to paid/cancel/refund but omitted
   `orders/create`. Both configs now include it so order correlation can be audited
   before `orders/paid`. This is local configuration only and was not deployed.

## HOLD boundary and alternate paths

- Current Next checkout: stock preflight -> POST /holds -> POST /checkout ->
  Shopify. The API verifies the token, state, expiration, accepted terms and
  allocated units, signs the binding, and guards persistence against old attempts.
- Shopify orders are not trusted merely because they include dates or a
  reservation ID. Binding, exact lines and checkout readiness are validated.
- A paid legacy order without a reservation binding is recorded as unresolved;
  it neither creates nor confirms a reservation. A new real-PostgreSQL regression
  test also proves it does not displace an existing HOLD or allocate another unit.
- This database safety does NOT prevent Shopify from accepting an unbound
  payment. Do not equate EXCLUDE/locks with a Shopify-side payment gate.
- Manual reservations intentionally do not require an online HOLD. They use the
  authenticated administrative path, RBAC, transaction, locks and the same
  physical capacity protections. This is an existing supported flow, not a bypass.
- No other public reservation-creation endpoint was found in the Nest modules.
  Availability and rental-plan are read-only; reservation status requires token.
- `apps/web` is an old Booqable frontend, not an integration with the new HOLD
  engine. Its Railway service exists but has no configured public domain and no
  Booqable environment variables in the inspected environment. It was not removed.
- The abandoned `theme/` is not the remote live Horizon theme and was not deployed.

## Remote evidence (read-only)

- Shopify store queried: `ar5sjt-7g.myshopify.com`.
- Shopify Admin GraphQL reports plan `Shopify`, `shopifyPlus=false` and
  `partnerDevelopment=false`. The store is neither Plus nor a development store.
- Active app version: `fase-7-webhooks`, created 2026-09-04.
- Live theme: Horizon, ID `159504302180`.
- Pulled templates, settings_data, sections, snippets and layout to a temporary
  inspection directory. None references rental-calendar/data-vsc-rental or an
  app block for that calendar. Conclusion: the legacy calendar is NOT enabled
  in the live theme inspected. This does not prove old released assets were deleted.
- Horizon product configuration contains native add-to-cart/accelerated checkout,
  and its cart-summary contains a native checkout submit button. These paths have
  no HOLD integration in the inspected theme. No platform-side validation was
  verified; this remains a release blocker, not a claimed successful bypass test.
- Public product GET redirected to `vsbycloset.myshopify.com/password` (HTTP 200).
  The storefront is password-protected. No password was bypassed, cart created,
  payment attempted or real customer data used.
- Connected Railway project `fabulous-compassion` has only `production`; no
  isolated staging environment is configured there.
- Production API /health returned 200 with `{"status":"ok"}`. This checks the
  deployed version only; it does not attest to these uncommitted local changes.
- DATABASE_URL is configured and uses a Neon hostname. API binding, admin,
  Shopify client and Storefront secrets are present; values were not printed.
  Presence is not proof of successful payment/webhook delivery.
- CORS permits `https://vs-by-closet.vercel.app`. The configured Shopify client ID
  matches the production app configuration. PICKUP_REMINDER_ENABLED is absent,
  so the existing disabled default applies. No notification provider was configured.
- Railway's inspected active deployment metadata has healthcheckPath=null.
  The checked-in /health configuration must actually be selected before release.
- Shopify production app config validation passed: valid=true, issues=[].
  Actual subscription delivery, Vercel preview variables, production migration
  state and any Shopify checkout-validation Function were not verified.

## Validation on this continuation

| Check | Result |
| --- | --- |
| pnpm install --frozen-lockfile | PASS; unchanged lockfile |
| Prisma generate | PASS, Prisma 5.22.0 |
| Migrations on fresh local PostgreSQL 16.13 | PASS, all 16 migrations |
| Next TypeScript | PASS |
| API TypeScript | PASS |
| API tests, including available webhook HTTP tests | PASS, 390 tests / 37 files, 42.61 s |
| New client/legacy/config regression suite | PASS, 16 tests, no skipped tests |
| API production build | PASS |
| Repository lint after correction | PASS, zero errors, one preexisting warning |
| Next production build on final changes | PASS, including TypeScript and 25 generated pages |
| Fresh compiled-API smoke | PASS: bootstrap, health 200, unauthenticated admin 401, reminders disabled |
| Shopify production config validation | PASS |
| Real staging/payment/webhook delivery tests | NOT RUN: no isolated staging established |

The lint warning is the unchanged CartDrawer.tsx:129 missing `show` dependency.
The first lint attempt found a new ref-initialization pattern error in the cart;
it was corrected and the full lint passed on retry. The previous temporary
PostgreSQL cluster failed to start because pg_notify was missing; a completely
new disposable cluster was initialized before applying migrations and tests.
Automatic approval initially blocked the Next build due to a usage limit. After
checking that the script only runs next build and has no prebuild/postbuild hooks,
a new approval was granted; the build and local smoke then passed. No failure was
suppressed and no continue-on-error was used. The disposable PostgreSQL is stopped
after verification, and no dev server is left running by this audit.

The 390 API tests include consistent expiration responses, unbound legacy paid-order
isolation, wrong/missing Shopify shop-domain rejection and concurrent store
initialization. Sixteen additional
Node tests cover client retries, stale results, intent changes, terms, stock
failure, calendar retirement, Railway and required `orders/create` configuration.
CI runs that suite too.

## Files changed in this continuation

- `.github/workflows/ci.yml`
- `apps/marketing/src/app/carrinho/page.tsx`
- `apps/marketing/src/lib/cart.ts`
- `apps/marketing/src/lib/checkout.ts`
- `apps/marketing/src/lib/checkout-attempt.ts` (new)
- `apps/reservations-api/railway.json`
- `apps/reservations-api/src/checkout/checkout.service.ts` (extends prior changes)
- `apps/reservations-api/src/backend-audit.integration.test.ts` (extends prior new file)
- `apps/reservations-api/src/holds/holds.service.ts`
- `apps/reservations-api/src/holds/holds.retry.test.ts`
- `apps/reservations-api/src/holds/store-config.ts`
- `apps/reservations-api/src/admin-reservations/admin-reservations.service.ts`
- `apps/reservations-api/src/webhooks/webhooks.controller.ts`
- `apps/reservations-api/src/webhooks/webhooks.controller.e2e.test.ts`
- `apps/reservations-api/src/webhooks/webhooks.service.ts`
- `apps/shopify-app/shopify.app.production.toml`
- `apps/shopify-app/shopify.app.cl.toml`
- `apps/shopify-app/extensions/rental-calendar/assets/rental-calendar.js`
- `apps/shopify-app/extensions/rental-calendar/blocks/rental_calendar.liquid`
- `apps/shopify-app/extensions/rental-calendar/locales/pt-BR.json`
- `apps/shopify-app/extensions/rental-calendar/locales/es.json`
- `apps/shopify-app/extensions/rental-calendar/locales/en.default.json`
- `apps/shopify-app/extensions/rental-calendar/README.md`
- `scripts/checkout-flow.test.mjs` (new)
- `docs/CHECKOUT-STAGING-AUDIT-2026-09-09.md` (new)

Prior backend changes and the additive HOLD snapshot migration are listed in
the previous report. No extra migration or commercial rule was introduced here.

## Release gates still open

1. Re-run CI on the target Linux/Node 20 environment; local checks
   used Windows/Node 24.14.0 and pnpm 10.30.3.
2. Establish an isolated staging API/frontend/database AND Shopify test store/app.
   Use a separate Neon branch/database and independent admin, binding, client and
   webhook secrets. Never point a preview at production's HOLD or webhook URLs.
   Configure all NEXT_PUBLIC availability/rental-plan/holds/checkout/status URLs
   and server admin URL consistently, with staging-only CORS and reminders=false.
3. In that isolated environment run controlled HOLD, expiration/release,
   concurrent checkout, late-payment and duplicate/reordered webhook scenarios,
   plus RBAC, reports, rules rollback and health. Existing local tests cover these
   backend scenarios but are not real Shopify delivery/payment acceptance tests.
4. Prove Shopify rejects rental payment without a valid current backend binding
   across native cart, accelerated checkout and direct Storefront carts. A theme
   button change or CORS is not sufficient server-side enforcement. Do not unlock
   the native channel as an unverified workaround. Platform solution and support
   must be reviewed in staging before changing the commercial storefront.
   Shopify's documented server-side mechanism is a Cart and Checkout Validation
   Function, including accelerated checkout. The inspected store is non-Plus and
   not a development store; current custom-app eligibility therefore does not
   establish an activatable production gate. No inert or presence-only Function
   was added because it would create false assurance without proving activation
   and backend validation in an eligible isolated store.
5. Verify production migrations, backup/rollback plan, actual Railway config path
   and healthcheck activation, Vercel variables and real webhook subscriptions.
   No destructive SQL or real production checkout tests were run in this audit.

Status: NOT officially ready for operation. Commit/push/deploy withheld because
the required gates are incomplete. No post-deploy smoke exists because no deploy
was performed. The production health GET is only a read-only observation.

## Final payment-provider decision

Mercado Pago is a payment method configured inside Shopify, not an integration
owned by this repository. An active-code audit found no Mercado Pago SDK, API,
credential, checkout or webhook. The reservations API never queries or confirms
payment with Mercado Pago: only a valid Shopify `orders/paid` webhook can confirm
a Reservation. Shopify `orders/cancelled` and `refunds/create` remain the external
signals for cancellation/refund handling. ClosetAdmin has no capture, approval,
refund, amount-editing or financial-order endpoint.

No Shopify inventory mutation exists in Reservation confirmation. Shopify remains
the authority for commerce and payment, while PostgreSQL remains the authority
for dated rental availability through RentalUnits and ReservationItems. Two
static regression tests protect these boundaries. No commercial value, extra-day
rule or notification setting was changed.

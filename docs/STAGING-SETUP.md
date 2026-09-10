# VS BY CLOSET staging setup

No isolated staging environment or Shopify test store was found on 2026-09-09.
Do not use the production database, production Shopify store, production app,
production webhook secret or customer data for these steps.

## Required isolated resources

1. Create a Railway `staging` environment with separate API and marketing
   services. Create a separate Neon branch/database. Confirm the resulting
   DATABASE_URL does not equal production before running migrations.
2. Create a Shopify development store and a separate app configuration linked
   to that store. The current production store is non-Plus and not a development
   store. Cart and Checkout Validation Function eligibility must be confirmed in
   the test store before using checkout as an acceptance gate.
3. Configure a staging frontend domain. Keep the storefront password enabled
   during homologation and restrict CORS to that exact origin.

## API variables

Set unique staging values; placeholders are intentionally not executable:

```text
NODE_ENV=production
DATABASE_URL=<isolated Neon staging URL>
CORS_ALLOWED_ORIGINS=https://<staging-frontend>
SHOPIFY_STORE_DOMAIN=<development-store>.myshopify.com
SHOPIFY_STORE_CURRENCY=<configured test currency>
SHOPIFY_STOREFRONT_TOKEN=<test-store token>
SHOPIFY_CLIENT_ID=<test-app client id>
SHOPIFY_CLIENT_SECRET=<test-app secret>
RESERVATION_BINDING_SECRET=<new random staging-only secret>
ADMIN_API_TOKEN=<new random staging-only secret>
TERMS_VERSION=<same approved current version>
PAYMENT_WINDOW_MINUTES=<same current value; do not invent a commercial value>
PICKUP_REMINDER_ENABLED=false
```

Use seed variables only for a controlled staging administrator. Never commit
their values. Do not copy a real customer's identity or PIN.

## Marketing variables

```text
NEXT_PUBLIC_AVAILABILITY_URL=https://<staging-api>/availability
NEXT_PUBLIC_RENTAL_PLAN_URL=https://<staging-api>/rental-plan/duration
NEXT_PUBLIC_HOLDS_URL=https://<staging-api>/holds
NEXT_PUBLIC_CHECKOUT_URL=https://<staging-api>/checkout
NEXT_PUBLIC_RESERVATIONS_URL=https://<staging-api>/reservations
NEXT_PUBLIC_RESERVATIONS_API_URL=https://<staging-api>
ADMIN_API_URL=https://<staging-api>
```

Keep all Shopify public Storefront variables pointed at the test store. Before
deploying, search the resolved environment for the production API hostname,
production frontend hostname, production store domain and production database
host; staging must contain none of them.

## Deployment order

1. Validate the separate Shopify config with
   `shopify app config validate --config staging --json`.
2. Install with the frozen lockfile and generate Prisma Client.
3. Run `prisma migrate deploy` only against the verified staging database.
4. Deploy API and require `/health` to return 200 before deploying marketing.
5. Deploy the separate Shopify test app/version. Do not deploy the production
   config. Verify webhook subscriptions include `orders/create`, `orders/paid`,
   `orders/cancelled` and `refunds/create`, all targeting the staging API.
6. Activate a Cart and Checkout Validation Function only after its build,
   eligibility and blocking behavior have been proven in the test store.

## Acceptance matrix

Use synthetic products and payment test mode. Record IDs only in private test
evidence, never in this repository.

| Scenario | Required result |
| --- | --- |
| Valid HOLD -> checkout -> approved test payment | Signed exact binding; reservation confirmed once |
| Native/accelerated/direct cart without HOLD | Checkout blocked before payment; otherwise release gate fails |
| Changed line/quantity after HOLD | Checkout blocked or webhook marks problem; never confirms |
| HOLD expired before checkout | API 410; no new Shopify cart |
| Payment after payment window | Atomic recovery only if original units remain valid/free; otherwise late_payment_conflict |
| Same units, concurrent buyers | At most one capacity winner; no double booking |
| Duplicate webhook | One WebhookEvent; no duplicate transition |
| paid/create/cancel/refund reordered | State machine result and audit match tests |
| Wrong/missing Shopify shop domain | HTTP 401/400; no WebhookEvent |
| Legacy calendar | No network call, cart mutation or enabled submit |
| Unauthenticated/expired STAFF session | 401; forbidden role action 403 |
| Rule/audit write failure | Transaction rollback |
| Reports around local midnight/Sunday | America/Santiago dates remain correct |

## Production gate

Production remains blocked until the native, accelerated and direct Storefront
checkout paths all reject rental purchases without a valid backend-issued HOLD.
Webhook containment prevents an invalid order from occupying rental availability,
but it cannot undo payment authorization. If the store/app cannot activate the
official validation Function, the platform/distribution limitation must be
resolved before opening checkout; theme-only button hiding is insufficient.

/**
 * One-time: create the Stripe usage-billing primitives (a Product + a Billing Meter + a metered Price) via
 * @suluk/stripe's setupUsageBilling, over the REST adapter. Run: `bun run scripts/setup-billing.ts`.
 * Copy the printed ids into .env (STRIPE_METER_EVENT_NAME, STRIPE_METERED_PRICE_ID) and `wrangler secret put`
 * them (or set as vars). The meter aggregates cost-µ$ usage; the metered price bills per unit (cost × markup).
 */
import { setupUsageBilling } from "@suluk/stripe";
import { restStripe } from "../src/server/stripe-rest";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error("set STRIPE_SECRET_KEY in .env"); process.exit(1); }

const ids = await setupUsageBilling(restStripe(key), {
  productName: "saasuluk usage",
  eventName: "saasuluk_cost",
  currency: "usd",
  unitAmountDecimal: "0.0002", // cents per cost-µ$ ≈ a 2× markup on the raw metered cost
  aggregation: "sum",
  interval: "month",
});

console.log("\n✓ Stripe usage billing created:\n");
console.log(`  STRIPE_METER_EVENT_NAME=${ids.eventName}`);
console.log(`  STRIPE_METER_ID=${ids.meterId}`);
console.log(`  STRIPE_METERED_PRICE_ID=${ids.priceId}`);
console.log(`  (product ${ids.productId})\n`);
console.log("→ add the EVENT_NAME + PRICE_ID to .env and the Worker (wrangler secret put / vars).");

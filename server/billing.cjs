"use strict";

const crypto = require("node:crypto");

const PLANS = Object.freeze({
  free: { id: "free", name: "Free", priceCents: 0, devices: 3, remoteCommands: false, perks: ["Live monitoring", "Activity monitor", "3 paired computers"] },
  plus: { id: "plus", name: "Plus", priceCents: 200, devices: 5, remoteCommands: true, perks: ["Remote battery & power-profile commands", "5 paired computers"] },
  pro: { id: "pro", name: "Pro", priceCents: 500, devices: 15, remoteCommands: true, perks: ["Everything in Plus", "15 paired computers"] },
  max: { id: "max", name: "Max", priceCents: 900, devices: 30, remoteCommands: true, perks: ["Everything in Pro", "30 paired computers", "Priority email support"] },
  business: { id: "business", name: "Professional", priceCents: 1900, devices: 100, remoteCommands: true, perks: ["Everything in Max", "100 paired computers", "Business support and Stripe invoices"] }
});
const PAID_IDS = Object.freeze(["plus", "pro", "max", "business"]);
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function planFor(row) {
  if (row && ACTIVE_STATUSES.has(row.status) && PLANS[row.plan]) return PLANS[row.plan];
  return PLANS.free;
}

function verifyStripeSignature(rawBody, header, secret, nowMs = Date.now(), toleranceSeconds = 300) {
  if (!secret || typeof header !== "string") return false;
  const parts = new Map();
  const signatures = [];
  for (const piece of header.split(",")) {
    const [key, value] = piece.split("=");
    if (key === "v1") signatures.push(value);
    else parts.set(key, value);
  }
  const timestamp = Number(parts.get("t"));
  if (!Number.isFinite(timestamp) || Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((signature) => {
    if (!/^[0-9a-f]{64}$/.test(signature || "")) return false;
    return crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"));
  });
}

async function stripeRequest(secretKey, fetchImpl, route, params) {
  const response = await fetchImpl(`https://api.stripe.com/v1${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe request failed");
  return data;
}

function createCheckout({ secretKey, fetchImpl, planId, account, returnUrl, customerId }) {
  const plan = PLANS[planId];
  const params = {
    mode: "subscription",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][unit_amount]": String(plan.priceCents),
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": `Northstar Control ${plan.name}`,
    client_reference_id: String(account.id),
    "metadata[plan]": plan.id,
    "metadata[owner_id]": String(account.id),
    "subscription_data[metadata][plan]": plan.id,
    "subscription_data[metadata][owner_id]": String(account.id),
    success_url: `${returnUrl}?billing=success`,
    cancel_url: `${returnUrl}?billing=cancelled`
  };
  if (customerId) params.customer = customerId;
  return stripeRequest(secretKey, fetchImpl, "/checkout/sessions", params);
}

function createPortal({ secretKey, fetchImpl, customerId, returnUrl }) {
  return stripeRequest(secretKey, fetchImpl, "/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
}

module.exports = { PLANS, PAID_IDS, planFor, verifyStripeSignature, createCheckout, createPortal };

// /api/webhook.js (Next.js Pages Router on Vercel)
// Gestisce:
// - orders/paid  -> GIACENZA / SPEDISCI_ORA
// - fulfillments/create -> quando Shopify genera tracking, accorpa la GIACENZA
//
// TEST_MODE=true: nessuna scrittura (tag, hold, fulfillment) viene eseguita. Solo log/letture.

export const config = {
  api: { bodyParser: false },
};

import crypto from "crypto";

// ===== TEST MODE =====
const TEST_MODE = String(process.env.TEST_MODE || "").toLowerCase() === "true";

// ===== Shipping methods (come nel checkout) =====
const SHIPPING_ACCUMULA = "Accumula da Nami!";
const SHIPPING_SDA = "SDA Express 24/48h";

// ===== Tags =====
const TAG_GIACENZA = "GIACENZA";
const TAG_SPEDISCI_ORA = "SPEDISCI_ORA";
const TAG_MERGE_IN_CORSO = "MERGE_IN_CORSO";
const TAG_MERGE_OK = "MERGE_OK";

// =========================
// Small helpers
// =========================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseTags(tagsStr) {
  return new Set((tagsStr || "").split(",").map((t) => t.trim()).filter(Boolean));
}
function tagsToString(set) {
  return Array.from(set).join(", ");
}
function addTags(tagsStr, tags) {
  const s = parseTags(tagsStr);
  for (const t of tags) s.add(t);
  return tagsToString(s);
}
function removeTags(tagsStr, tags) {
  const s = parseTags(tagsStr);
  for (const t of tags) s.delete(t);
  return tagsToString(s);
}
function hasTag(tagsStr, tag) {
  return parseTags(tagsStr).has(tag);
}
function orderGid(orderIdNum) {
  return `gid://shopify/Order/${orderIdNum}`;
}
function fulfillmentOrderGidFromRestId(restIdNum) {
  return `gid://shopify/FulfillmentOrder/${restIdNum}`;
}

// =========================
// Token 24h (Client Credentials Grant) + cache in-memory
// =========================
let cachedToken = null;
let cachedExpiryMs = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExpiryMs) return cachedToken;

  const shop = process.env.SHOPIFY_SHOP_DOMAIN; // MUST be: gb6zdg-vk.myshopify.com
  const client_id = process.env.SHOPIFY_API_KEY;
  const client_secret = process.env.SHOPIFY_API_SECRET;

  if (!shop || !client_id || !client_secret) {
    throw new Error("Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_API_KEY / SHOPIFY_API_SECRET env vars.");
  }

  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ client_id, client_secret, grant_type: "client_credentials" }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${JSON.stringify(json)}`);

  cachedToken = json.access_token;
  const expiresIn = Number(json.expires_in || 86400);
  cachedExpiryMs = Date.now() + (expiresIn - 60) * 1000; // 60s margin

  return cachedToken;
}

// =========================
// Shopify REST helper
// =========================
async function shopifyRest(path, { method = "GET", body } = {}) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = await getAccessToken();

  const url = `https://${shop}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    throw new Error(`REST ${method} ${path} -> ${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function shopifyRestWrite(path, { method, body }) {
  if (TEST_MODE) {
    console.log("🧪 TEST_MODE: SKIP REST WRITE", method, path, body ? JSON.stringify(body) : "");
    return { skipped: true };
  }
  return shopifyRest(path, { method, body });
}

// =========================
// Shopify GraphQL helper (usato per hold/release hold)
// =========================
async function shopifyGraphql(query, variables = {}) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = await getAccessToken();

  const url = `https://${shop}/admin/api/2026-01/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function shopifyGraphqlMutation(query, variables = {}) {
  if (TEST_MODE) {
    console.log("🧪 TEST_MODE: SKIP GraphQL MUTATION", JSON.stringify({ variables }));
    return { skipped: true };
  }
  return shopifyGraphql(query, variables);
}

// =========================
// Webhook HMAC verification
// =========================
function verifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET env var.");

  const generated = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const a = Buffer.from(generated, "utf8");
  const b = Buffer.from(String(hmacHeader || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// =========================
// Fulfillment hold / release hold (GraphQL expects GIDs)
// =========================
async function holdFulfillmentOrders(fulfillmentOrderGids, note = "Ordine in giacenza (Accumula da Nami!)") {
  const m = `
    mutation Hold($id: ID!, $reason: FulfillmentHoldReason!, $reasonNotes: String) {
      fulfillmentOrderHold(id: $id, reason: $reason, reasonNotes: $reasonNotes) {
        fulfillmentOrder { id status }
        userErrors { field message }
      }
    }
  `;

  for (const foGid of fulfillmentOrderGids) {
    const data = await shopifyGraphqlMutation(m, {
      id: foGid,
      reason: "OTHER",
      reasonNotes: note,
    });
    if (data?.skipped) continue;

    const errs = data.fulfillmentOrderHold?.userErrors || [];
    if (errs.length) console.warn("fulfillmentOrderHold userErrors:", errs);
  }
}

async function releaseFulfillmentOrderHold(fulfillmentOrderGid) {
  const m = `
    mutation ReleaseHold($id: ID!) {
      fulfillmentOrderReleaseHold(id: $id) {
        fulfillmentOrder { id status }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphqlMutation(m, { id: fulfillmentOrderGid });
  if (data?.skipped) return;

  const errs = data.fulfillmentOrderReleaseHold?.userErrors || [];
  if (errs.length) console.warn("fulfillmentOrderReleaseHold userErrors:", errs);
}

// =========================
// Read Fulfillment Orders reliably via REST + retry
// =========================
async function getFulfillmentOrdersRest(orderId) {
  const resp = await shopifyRest(`/admin/api/2026-01/orders/${orderId}/fulfillment_orders.json`, { method: "GET" });
  return resp.fulfillment_orders || [];
}

async function getFulfillmentOrderGidsWithRetry(orderId) {
  // retry pattern: 2s, 5s, 10s, 20s  (total ~37s)
  const waits = [0, 2000, 5000, 10000, 20000];
  for (let i = 0; i < waits.length; i++) {
    const w = waits[i];
    if (w) {
      console.log(`🕒 ACCUMULA -> FO non pronti, riprovo tra ${w}ms...`);
      await sleep(w);
    }

    const fos = await getFulfillmentOrdersRest(orderId);
    const gids = fos.map((fo) => fulfillmentOrderGidFromRestId(fo.id));

    if (gids.length) return { fos, gids };
  }
  return { fos: [], gids: [] };
}

// =========================
// Handler: orders/paid
// =========================
async function handleOrdersPaid(payload) {
  const orderId = payload?.id;
  if (!orderId) return "OK (no order id)";

  const shippingTitle = payload?.shipping_lines?.[0]?.title || "";
  const orderName = payload?.name || orderId;

  // log basic
  console.log(`📦 orders/paid: ${orderName} | shipping: ${shippingTitle} | tags: ${(payload?.tags || "").trim?.() || ""}`);

  // Leggiamo i tags live (ordine può avere tags diversi rispetto al payload)
  const orderResp = await shopifyRest(
    `/admin/api/2026-01/orders/${orderId}.json?fields=id,name,tags,customer,fulfillment_status,shipping_lines`,
    { method: "GET" }
  );
  const live = orderResp.order;
  const currentTags = live?.tags || "";

  // A) ACCUMULA
  if (shippingTitle === SHIPPING_ACCUMULA) {
    const wouldTags = addTags(currentTags, [TAG_GIACENZA]);
    console.log("🧊 ACCUMULA -> vorrei taggare GIACENZA:", wouldTags);

    await shopifyRestWrite(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: wouldTags } },
    });

    // FO via REST (affidabile) + retry
    const { gids } = await getFulfillmentOrderGidsWithRetry(orderId);

    console.log("🧊 ACCUMULA -> vorrei mettere HOLD su FO (GIDs):", gids);

    if (gids.length) {
      await holdFulfillmentOrders(gids);
    } else {
      console.log("⚠️ ACCUMULA -> ancora FO vuoti dopo retry, non posso mettere HOLD");
    }

    return "OK GIACENZA";
  }

  // B) SDA
  if (shippingTitle === SHIPPING_SDA) {
    // idempotenza: se già ok/in corso, skip
    if (hasTag(currentTags, TAG_MERGE_OK) || hasTag(currentTags, TAG_MERGE_IN_CORSO)) {
      console.log("🔁 SDA -> già gestito/in corso, skip:", orderName);
      return "SKIP already handled";
    }

    const wouldTags = addTags(currentTags, [TAG_SPEDISCI_ORA, TAG_MERGE_IN_CORSO]);
    console.log("🚚 SDA -> vorrei taggare:", wouldTags);

    await shopifyRestWrite(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: wouldTags } },
    });

    console.log("🚚 SDA -> attendo fulfillments/create (tracking) per accorpare le giacenze.");
    return "OK SDA tagged";
  }

  return "OK (ignored shipping method)";
}

// =========================
// Handler: fulfillments/create
// =========================
async function handleFulfillmentCreate(payload) {
  const fulfillmentId = payload?.id;
  const orderId = payload?.order_id;
  const trackingNumber = payload?.tracking_number || payload?.tracking_numbers?.[0];
  const trackingCompany = payload?.tracking_company || payload?.tracking_company_name || "SDA";
  const trackingUrl = payload?.tracking_url || payload?.tracking_urls?.[0];

  if (!orderId) return "OK (no order_id)";

  if (!trackingNumber) {
    console.log("⚠️ fulfillments/create senza tracking -> skip", fulfillmentId, "order", orderId);
    return "SKIP no tracking";
  }

  const triggerResp = await shopifyRest(
    `/admin/api/2026-01/orders/${orderId}.json?fields=id,name,customer,tags,fulfillment_status,shipping_lines`,
    { method: "GET" }
  );
  const trigger = triggerResp.order;

  const orderName = trigger?.name || orderId;
  const customerId = trigger?.customer?.id;
  const triggerTags = trigger?.tags || "";
  const triggerShippingTitle = trigger?.shipping_lines?.[0]?.title || "";

  console.log(`📦 fulfillments/create: ${orderName} | tracking: ${trackingNumber} | TEST_MODE: ${TEST_MODE}`);

  // procediamo solo per ordine SDA (o tag SPEDISCI_ORA)
  if (!(triggerShippingTitle === SHIPPING_SDA || hasTag(triggerTags, TAG_SPEDISCI_ORA))) {
    console.log("ℹ️ fulfillment di ordine non SDA, ignoro:", orderName);
    return "OK ignored";
  }

  if (!customerId) {
    console.log("⚠️ order senza customer_id, skip:", orderName);
    return "SKIP no customer";
  }

  // idempotenza
  if (hasTag(triggerTags, TAG_MERGE_OK)) {
    console.log("🔁 MERGE_OK già presente, skip:", orderName);
    return "SKIP already merged";
  }

  // prendi ordini customer
  const list = await shopifyRest(
    `/admin/api/2026-01/orders.json?status=any&limit=250&customer_id=${customerId}&fields=id,name,tags,fulfillment_status`,
    { method: "GET" }
  );

  const orders = list.orders || [];
  const giacenze = orders.filter((o) => {
    const fs = o.fulfillment_status; // null | unfulfilled | partial | fulfilled
    const notShipped = (fs == null || fs === "unfulfilled");
    return hasTag(o.tags || "", TAG_GIACENZA) && notShipped;
  });

  console.log(`🔗 SDA -> giacenze non spedite trovate: ${giacenze.length}`);

  for (const o of giacenze) {
    console.log(`➡️ Accorpo (simulate if TEST_MODE) ordine ${o.name} (${o.id}) con tracking ${trackingNumber}`);

    // 1) Release hold su FO (serve GID). Prendiamo FO via REST, poi convertiamo a GID.
    const fosRest = await getFulfillmentOrdersRest(o.id);
    const foGids = fosRest.map((fo) => fulfillmentOrderGidFromRestId(fo.id));

    if (foGids.length) {
      console.log("   - Vorrei release hold FO:", foGids);
      for (const gid of foGids) await releaseFulfillmentOrderHold(gid);
    } else {
      console.log("   - ⚠️ Nessun FO trovato via REST per ordine giacenza (strano):", o.id);
    }

    // 2) Crea fulfillment per ogni fulfillment_order_id REST
    for (const fo of fosRest) {
      if (fo.status === "closed" || fo.status === "cancelled") continue;

      console.log("   - Vorrei creare fulfillment per FO id:", fo.id);

      await shopifyRestWrite(`/admin/api/2026-01/fulfillments.json`, {
        method: "POST",
        body: {
          fulfillment: {
            message: `Accorpato a spedizione ${orderName}`,
            notify_customer: true,
            tracking_info: {
              number: trackingNumber,
              company: trackingCompany,
              ...(trackingUrl ? { url: trackingUrl } : {}),
            },
            line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }],
          },
        },
      });
    }

    // 3) aggiorna tag ordine giacenza (togli GIACENZA, aggiungi MERGE_OK)
    const wouldTags = addTags(removeTags(o.tags || "", [TAG_GIACENZA]), [TAG_MERGE_OK]);
    console.log("   - Vorrei aggiornare tags GIACENZA ->", wouldTags);

    await shopifyRestWrite(`/admin/api/2026-01/orders/${o.id}.json`, {
      method: "PUT",
      body: { order: { id: o.id, tags: wouldTags } },
    });
  }

  // chiudi merge su ordine trigger: MERGE_OK e togli MERGE_IN_CORSO
  const triggerWould = removeTags(addTags(triggerTags, [TAG_MERGE_OK]), [TAG_MERGE_IN_CORSO]);
  console.log("✅ Vorrei chiudere merge su ordine SDA:", orderName, "->", triggerWould);

  await shopifyRestWrite(`/admin/api/2026-01/orders/${orderId}.json`, {
    method: "PUT",
    body: { order: { id: orderId, tags: triggerWould } },
  });

  return "OK merged";
}

// =========================
// Main webhook handler
// =========================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // read raw body
  const rawBody = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const topic = req.headers["x-shopify-topic"]; // "orders/paid" / "fulfillments/create"

  try {
    if (!hmacHeader || typeof hmacHeader !== "string") {
      return res.status(401).send("Missing HMAC header");
    }
    if (!verifyHmac(rawBody, hmacHeader)) {
      console.log("HMAC validation failed");
      return res.status(401).send("HMAC validation failed");
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).send("Invalid JSON"); }

    console.log("✅ Webhook OK topic:", topic, "| TEST_MODE:", TEST_MODE);

    if (topic === "orders/paid") {
      const out = await handleOrdersPaid(payload);
      return res.status(200).send(out);
    }

    if (topic === "fulfillments/create") {
      const out = await handleFulfillmentCreate(payload);
      return res.status(200).send(out);
    }

    return res.status(200).send("OK (topic ignored)");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    // 200 per evitare retry infiniti durante sviluppo
    return res.status(200).send("ERROR handled");
  }
}

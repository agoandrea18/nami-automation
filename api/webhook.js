// /api/webhook.js  (Next.js Pages Router)
// Webhook unico: orders/paid + fulfillments/create
// TEST_MODE=true => NON modifica niente (solo log e letture)

export const config = {
  api: {
    bodyParser: false, // necessario per HMAC sul raw body
  },
};

import crypto from "crypto";

// ====== TEST MODE ======
const TEST_MODE = String(process.env.TEST_MODE || "").toLowerCase() === "true";

// === NOMI METODI SPEDIZIONE (come nel checkout) ===
const SHIPPING_ACCUMULA = "Accumula da Nami!";
const SHIPPING_SDA = "SDA Express 24/48h";

// === TAG (come nel tuo codice) ===
const TAG_GIACENZA = "GIACENZA";
const TAG_SPEDISCI_ORA = "SPEDISCI_ORA";
const TAG_MERGE_IN_CORSO = "MERGE_IN_CORSO";
const TAG_MERGE_OK = "MERGE_OK";

// =========================
// Token 24h (client credentials grant) + cache in-memory
// =========================
let cachedToken = null;
let cachedExpiryMs = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExpiryMs) return cachedToken;

  const shop = process.env.SHOPIFY_SHOP_DOMAIN; // es: gb6zdg-vk.myshopify.com
  const client_id = process.env.SHOPIFY_API_KEY;
  const client_secret = process.env.SHOPIFY_API_SECRET;

  if (!shop || !client_id || !client_secret) {
    throw new Error("Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_API_KEY / SHOPIFY_API_SECRET env vars.");
  }

  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      client_id,
      client_secret,
      grant_type: "client_credentials",
    }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${JSON.stringify(json)}`);

  cachedToken = json.access_token;
  const expiresIn = Number(json.expires_in || 86400);
  cachedExpiryMs = Date.now() + (expiresIn - 60) * 1000; // margine 60s

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

// Wrapper: blocca ogni scrittura in TEST_MODE
async function shopifyRestWrite(path, { method, body }) {
  if (TEST_MODE) {
    console.log("🧪 TEST_MODE: SKIP REST WRITE", method, path, body ? JSON.stringify(body) : "");
    return { skipped: true };
  }
  return shopifyRest(path, { method, body });
}

// =========================
// Shopify GraphQL helper
// =========================
async function shopifyGraphql(query, variables = {}) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = await getAccessToken();

  const url = `https://${shop}/admin/api/2026-01/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();

  if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json.data;
}

// Wrapper: blocca ogni mutation in TEST_MODE
async function shopifyGraphqlMutation(query, variables = {}) {
  if (TEST_MODE) {
    console.log("🧪 TEST_MODE: SKIP GraphQL MUTATION", JSON.stringify({ variables }));
    return { skipped: true };
  }
  return shopifyGraphql(query, variables);
}

// =========================
// Utils tags
// =========================
function parseTags(tagsStr) {
  return new Set((tagsStr || "").split(",").map(t => t.trim()).filter(Boolean));
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

// =========================
// HMAC verify
// =========================
function verifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET env var.");

  const generated = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const a = Buffer.from(generated, "utf8");
  const b = Buffer.from(hmacHeader || "", "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// =========================
// Fulfillment hold / release hold
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

  for (const foId of fulfillmentOrderGids) {
    const data = await shopifyGraphqlMutation(m, {
      id: foId,
      reason: "OTHER",
      reasonNotes: note,
    });

    // in test mode data.skipped
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
// ORDERS/PAID handler
// =========================
async function handleOrdersPaid(payload) {
  const orderId = payload?.id;
  if (!orderId) return "OK (no order id)";

  const shippingTitle = payload?.shipping_lines?.[0]?.title || "";
  const orderName = payload?.name || orderId;

  const orderGid = `gid://shopify/Order/${orderId}`;

  const q = `
    query OrderBasic($id: ID!) {
      order(id: $id) {
        id
        name
        tags
        customer { id }
        fulfillmentOrders(first: 50) {
          nodes { id status requestStatus }
        }
      }
    }
  `;
  const data = await shopifyGraphql(q, { id: orderGid });
  const live = data.order;

  const currentTagsArr = (live?.tags || []).map(t => t.trim());
  const currentTagsStr = currentTagsArr.join(", ");

  console.log("📦 orders/paid:", orderName, "| shipping:", shippingTitle, "| tags:", currentTagsStr);

  // A) ACCUMULA
  if (shippingTitle === SHIPPING_ACCUMULA) {
    const wouldTags = addTags(currentTagsStr, [TAG_GIACENZA]);
    console.log("🧊 ACCUMULA -> vorrei taggare GIACENZA:", wouldTags);

    await shopifyRestWrite(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: wouldTags } },
    });

    const foGids = (live?.fulfillmentOrders?.nodes || []).map(n => n.id);
    console.log("🧊 ACCUMULA -> vorrei mettere HOLD su FO:", foGids);
    if (foGids.length) await holdFulfillmentOrders(foGids);

    return "OK GIACENZA (test ok)";
  }

  // B) SDA
  if (shippingTitle === SHIPPING_SDA) {
    if (currentTagsArr.includes(TAG_MERGE_OK) || currentTagsArr.includes(TAG_MERGE_IN_CORSO)) {
      console.log("🔁 SDA -> già gestito/in corso, skip:", orderName);
      return "SKIP already handled";
    }

    const wouldTags = addTags(currentTagsStr, [TAG_SPEDISCI_ORA, TAG_MERGE_IN_CORSO]);
    console.log("🚚 SDA -> vorrei taggare:", wouldTags);

    await shopifyRestWrite(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: wouldTags } },
    });

    return "OK SDA tagged (test ok)";
  }

  return "OK ignored shipping method";
}

// =========================
// FULFILLMENTS/CREATE handler
// =========================
async function handleFulfillmentCreate(payload) {
  const orderId = payload?.order_id;
  const trackingNumber = payload?.tracking_number || payload?.tracking_numbers?.[0];
  const trackingCompany = payload?.tracking_company || "SDA";
  const trackingUrl = payload?.tracking_url || payload?.tracking_urls?.[0];

  if (!orderId) return "OK (no order_id)";
  if (!trackingNumber) {
    console.log("⚠️ fulfillments/create senza tracking -> skip", payload?.id, "order", orderId);
    return "SKIP no tracking yet";
  }

  const triggerOrderResp = await shopifyRest(
    `/admin/api/2026-01/orders/${orderId}.json?fields=id,name,customer,tags,fulfillment_status,shipping_lines`,
    { method: "GET" }
  );
  const triggerOrder = triggerOrderResp.order;
  const orderName = triggerOrder?.name || orderId;
  const customerId = triggerOrder?.customer?.id;

  const triggerTags = triggerOrder?.tags || "";
  const triggerShippingTitle = triggerOrder?.shipping_lines?.[0]?.title || "";

  console.log("📦 fulfillments/create:", orderName, "| tracking:", trackingNumber);

  if (!(triggerShippingTitle === SHIPPING_SDA || hasTag(triggerTags, TAG_SPEDISCI_ORA))) {
    console.log("ℹ️ non SDA, ignoro:", orderName);
    return "OK ignored (not SDA)";
  }
  if (!customerId) return "SKIP no customer";

  if (hasTag(triggerTags, TAG_MERGE_OK)) {
    console.log("🔁 MERGE_OK già presente, skip:", orderName);
    return "SKIP already merged";
  }

  const listResp = await shopifyRest(
    `/admin/api/2026-01/orders.json?status=any&limit=250&customer_id=${customerId}&fields=id,name,tags,fulfillment_status`,
    { method: "GET" }
  );

  const orders = listResp.orders || [];
  const giacenze = orders.filter(o => {
    const fs = o.fulfillment_status;
    const notShipped = (fs == null || fs === "unfulfilled");
    return hasTag(o.tags || "", TAG_GIACENZA) && notShipped;
  });

  console.log(`🔗 SDA -> trovate giacenze non spedite: ${giacenze.length}`);

  for (const o of giacenze) {
    console.log(`➡️ Vorrei accorpare ordine ${o.name} (${o.id}) al tracking ${trackingNumber}`);

    // 1) Recupero FO gid (read)
    const orderGid = `gid://shopify/Order/${o.id}`;
    const q = `
      query FOIds($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 50) { nodes { id status } }
          tags
          name
        }
      }
    `;
    const data = await shopifyGraphql(q, { id: orderGid });
    const foGids = data?.order?.fulfillmentOrders?.nodes?.map(n => n.id) || [];
    console.log("   - Vorrei release hold FO:", foGids);

    for (const foGid of foGids) {
      await releaseFulfillmentOrderHold(foGid);
    }

    // 2) Recupero fulfillment_orders numeric (read)
    const foResp = await shopifyRest(`/admin/api/2026-01/orders/${o.id}/fulfillment_orders.json`, { method: "GET" });
    const fos = foResp.fulfillment_orders || [];

    for (const fo of fos) {
      if (fo.status === "closed" || fo.status === "cancelled") continue;

      console.log("   - Vorrei creare fulfillment per FO id:", fo.id, "con tracking:", trackingNumber);

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
            line_items_by_fulfillment_order: [
              { fulfillment_order_id: fo.id },
            ],
          },
        },
      });
    }

    // 3) Aggiorno tag (write) -> skip in test
    const wouldTags = addTags(removeTags(o.tags || "", [TAG_GIACENZA]), [TAG_MERGE_OK]);
    console.log("   - Vorrei aggiornare tags ordine GIACENZA ->", wouldTags);

    await shopifyRestWrite(`/admin/api/2026-01/orders/${o.id}.json`, {
      method: "PUT",
      body: { order: { id: o.id, tags: wouldTags } },
    });
  }

  // Chiudo merge sul trigger (write) -> skip in test
  const triggerWould = removeTags(addTags(triggerTags, [TAG_MERGE_OK]), [TAG_MERGE_IN_CORSO]);
  console.log("✅ Vorrei chiudere merge su ordine SDA:", orderName, "->", triggerWould);

  await shopifyRestWrite(`/admin/api/2026-01/orders/${orderId}.json`, {
    method: "PUT",
    body: { order: { id: orderId, tags: triggerWould } },
  });

  return "OK merge simulated (test ok)";
}

// =========================
// Main handler
// =========================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const topic = req.headers["x-shopify-topic"];

  try {
    if (!hmacHeader || typeof hmacHeader !== "string") {
      return res.status(401).send("Missing HMAC header");
    }
    if (!verifyHmac(rawBody, hmacHeader)) {
      console.log("HMAC validation failed");
      return res.status(401).send("HMAC validation failed");
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).send("Invalid JSON");
    }

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
    return res.status(200).send("ERROR handled");
  }
}

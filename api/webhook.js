// /api/webhook.js  (Next.js Pages Router)
// Webhook unico che gestisce sia "orders/paid" sia "fulfillments/create"

export const config = {
  api: {
    bodyParser: false, // necessario per HMAC sul raw body
  },
};

import crypto from "crypto";

// === NOMI METODI SPEDIZIONE (come nel checkout) ===
const SHIPPING_ACCUMULA = "Accumula da Nami!";
const SHIPPING_SDA = "SDA Express 24/48h";

// === TAG ===
const TAG_GIACENZA = "GIACENZA";
const TAG_SPEDISCI_ORA = "SPEDISCI_ORA";
const TAG_MERGE_IN_CORSO = "MERGE_IN_CORSO";
const TAG_MERGE_OK = "MERGE_OK";
const TAG_MERGE_DONE_FROM = "MERGE_SDA_DONE"; // opzionale, storico

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
      "Content-Type": body ? "application/json" : "application/json",
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

// =========================
// Shopify GraphQL helper (per hold/release hold)
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
    const data = await shopifyGraphql(m, {
      id: foId,
      reason: "OTHER",
      reasonNotes: note,
    });

    const errs = data.fulfillmentOrderHold?.userErrors || [];
    if (errs.length) {
      console.warn("fulfillmentOrderHold userErrors:", errs);
    }
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

  const data = await shopifyGraphql(m, { id: fulfillmentOrderGid });
  const errs = data.fulfillmentOrderReleaseHold?.userErrors || [];
  if (errs.length) {
    console.warn("fulfillmentOrderReleaseHold userErrors:", errs);
  }
}

// =========================
// ORDERS/PAID handler
// =========================
async function handleOrdersPaid(payload) {
  const orderId = payload?.id;
  if (!orderId) return "OK (no order id)";

  const shippingTitle = payload?.shipping_lines?.[0]?.title || "";
  const orderName = payload?.name || orderId;

  // Prendi ordine live (tags, fulfillment_orders) via GraphQL per hold
  // (Potremmo farlo anche via REST, ma qui già usiamo GraphQL per FO gid)
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

  // A) ACCUMULA -> GIACENZA + HOLD FO
  if (shippingTitle === SHIPPING_ACCUMULA) {
    const newTags = addTags(currentTagsStr, [TAG_GIACENZA]);
    await shopifyRest(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: newTags } },
    });

    const foGids = (live?.fulfillmentOrders?.nodes || []).map(n => n.id);
    if (foGids.length) {
      await holdFulfillmentOrders(foGids);
    }

    console.log("🧊 GIACENZA OK:", orderName);
    return "OK GIACENZA";
  }

  // B) SDA -> tag SPEDISCI_ORA + MERGE_IN_CORSO (accorpo avverrà su fulfillments/create)
  if (shippingTitle === SHIPPING_SDA) {
    // idempotenza: se già ok/in corso, skip
    if (currentTagsArr.includes(TAG_MERGE_OK) || currentTagsArr.includes(TAG_MERGE_IN_CORSO)) {
      console.log("🔁 Merge già gestito/in corso, skip:", orderName);
      return "SKIP already handled";
    }

    const newTags = addTags(currentTagsStr, [TAG_SPEDISCI_ORA, TAG_MERGE_IN_CORSO]);
    await shopifyRest(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: newTags } },
    });

    console.log("🚚 TRIGGER SDA OK (attendo tracking da Shopify):", orderName);
    return "OK SDA tagged";
  }

  console.log("ℹ️ Metodo spedizione non gestito:", shippingTitle);
  return "OK ignored shipping method";
}

// =========================
// FULFILLMENTS/CREATE handler (qui c’è il tracking di Shopify)
// =========================
async function handleFulfillmentCreate(payload) {
  // Payload fulfillment
  const fulfillmentId = payload?.id;
  const orderId = payload?.order_id;
  const trackingNumber = payload?.tracking_number || payload?.tracking_numbers?.[0];
  const trackingCompany = payload?.tracking_company || payload?.tracking_company_name || "SDA";
  const trackingUrl = payload?.tracking_url || payload?.tracking_urls?.[0];

  if (!orderId) return "OK (no order_id)";

  // Se non c’è tracking, non possiamo accorpare (Shopify a volte crea fulfillment senza tracking)
  if (!trackingNumber) {
    console.log("⚠️ fulfillment/create senza tracking, skip:", fulfillmentId, "order", orderId);
    return "SKIP no tracking yet";
  }

  // Prendi ordine trigger (per customer + tags)
  const triggerOrderResp = await shopifyRest(
    `/admin/api/2026-01/orders/${orderId}.json?fields=id,name,customer,tags,fulfillment_status,shipping_lines`,
    { method: "GET" }
  );
  const triggerOrder = triggerOrderResp.order;
  const orderName = triggerOrder?.name || orderId;
  const customerId = triggerOrder?.customer?.id;

  if (!customerId) {
    console.log("⚠️ order senza customer_id, skip:", orderName);
    return "SKIP no customer";
  }

  const triggerTags = triggerOrder?.tags || "";
  const triggerShippingTitle = triggerOrder?.shipping_lines?.[0]?.title || "";

  // Procediamo solo se è un ordine SDA (o taggato SPEDISCI_ORA)
  if (!(triggerShippingTitle === SHIPPING_SDA || hasTag(triggerTags, TAG_SPEDISCI_ORA))) {
    console.log("ℹ️ fulfillment di ordine non SDA, ignoro:", orderName);
    return "OK ignored (not SDA)";
  }

  // Idempotenza: se già MERGE_OK, non rifare
  if (hasTag(triggerTags, TAG_MERGE_OK)) {
    console.log("🔁 MERGE_OK già presente, skip:", orderName);
    return "SKIP already merged";
  }

  // Prendi ordini del customer e filtra GIACENZA non spediti
  const listResp = await shopifyRest(
    `/admin/api/2026-01/orders.json?status=any&limit=250&customer_id=${customerId}&fields=id,name,tags,fulfillment_status`,
    { method: "GET" }
  );

  const orders = listResp.orders || [];
  const giacenze = orders.filter(o => {
    const t = o.tags || "";
    const fs = o.fulfillment_status; // null | "unfulfilled" | "partial" | "fulfilled"
    const notShipped = (fs == null || fs === "unfulfilled");
    return hasTag(t, TAG_GIACENZA) && notShipped;
  });

  if (giacenze.length === 0) {
    // Anche se non ci sono giacenze, chiudiamo merge ok sull’ordine trigger
    const newTags = removeTags(addTags(triggerTags, [TAG_MERGE_OK, TAG_MERGE_DONE_FROM]), [TAG_MERGE_IN_CORSO]);
    await shopifyRest(`/admin/api/2026-01/orders/${orderId}.json`, {
      method: "PUT",
      body: { order: { id: orderId, tags: newTags } },
    });

    console.log("✅ Nessuna giacenza da accorpare. Merge OK:", orderName);
    return "OK no giacenze";
  }

  console.log(`🔗 Accorpo ${giacenze.length} ordini GIACENZA a tracking ${trackingNumber} per customer ${customerId}`);

  // Per ciascun ordine GIACENZA:
  // - prendi fulfillment_orders
  // - release hold (se presente)
  // - crea fulfillment con stesso tracking
  for (const o of giacenze) {
    const foResp = await shopifyRest(`/admin/api/2026-01/orders/${o.id}/fulfillment_orders.json`, { method: "GET" });
    const fos = foResp.fulfillment_orders || [];

    // release hold su FO (GraphQL richiede GID: lo trovi già in REST? REST ritorna numeric id,
    // ma per release hold serve gid. Quindi usiamo query GraphQL per ottenere i gid dei FO di quell'ordine.)
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

    for (const foGid of foGids) {
      await releaseFulfillmentOrderHold(foGid);
    }

    // crea fulfillment via REST usando i fulfillment_order_id (numeric) che arrivano dal REST
    // e stesso tracking per tutti
    for (const fo of fos) {
      // Se è chiuso/cancellato, salta
      if (fo.status === "closed" || fo.status === "cancelled") continue;

      await shopifyRest(`/admin/api/2026-01/fulfillments.json`, {
        method: "POST",
        body: {
          fulfillment: {
            message: `Accorpato a spedizione ${orderName}`,
            notify_customer: true,
            tracking_info: {
              number: trackingNumber,
              company: trackingCompany || "SDA",
              ...(trackingUrl ? { url: trackingUrl } : {}),
            },
            line_items_by_fulfillment_order: [
              { fulfillment_order_id: fo.id },
            ],
          },
        },
      });
    }

    // aggiorna tag: rimuovi GIACENZA, aggiungi MERGE_OK
    const updated = addTags(removeTags(o.tags || "", [TAG_GIACENZA]), [TAG_MERGE_OK]);
    await shopifyRest(`/admin/api/2026-01/orders/${o.id}.json`, {
      method: "PUT",
      body: { order: { id: o.id, tags: updated } },
    });
  }

  // Infine: aggiorna ordine trigger: MERGE_OK e togli MERGE_IN_CORSO
  const triggerNewTags = removeTags(addTags(triggerTags, [TAG_MERGE_OK, TAG_MERGE_DONE_FROM]), [TAG_MERGE_IN_CORSO]);
  await shopifyRest(`/admin/api/2026-01/orders/${orderId}.json`, {
    method: "PUT",
    body: { order: { id: orderId, tags: triggerNewTags } },
  });

  console.log("✅ Merge completato per:", orderName);
  return "OK merged";
}

// =========================
// Main handler
// =========================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // leggi raw body
  const rawBody = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const topic = req.headers["x-shopify-topic"]; // es: "orders/paid" oppure "fulfillments/create"

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

    console.log("✅ Webhook OK topic:", topic);

    // Dispatch per topic
    if (topic === "orders/paid") {
      const out = await handleOrdersPaid(payload);
      return res.status(200).send(out);
    }

    if (topic === "fulfillments/create") {
      const out = await handleFulfillmentCreate(payload);
      return res.status(200).send(out);
    }

    // altri topic ignorati
    return res.status(200).send("OK (topic ignored)");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    // Rispondi 200 per evitare retry infiniti mentre sviluppi
    return res.status(200).send("ERROR handled");
  }
}

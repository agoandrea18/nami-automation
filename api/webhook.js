export const config = {
  api: {
    bodyParser: false, // IMPORTANT: serve per verificare l'HMAC sul raw body
  },
};

import crypto from "crypto";

// === NOMI METODI SPEDIZIONE (quelli che vedi nel checkout) ===
const SHIPPING_ACCUMULA = "Accumula da Nami!";
const SHIPPING_SDA = "SDA Express 24/48h";

// === TAG ===
const TAG_GIACENZA = "GIACENZA";
const TAG_SPEDISCI_ORA = "SPEDISCI_ORA";
const TAG_MERGE_IN_CORSO = "MERGE_IN_CORSO";
const TAG_MERGE_OK = "MERGE_OK";

// === GraphQL helper ===
async function shopifyGraphql(query, variables = {}) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN; // es: namicards.com
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // Admin API access token

  if (!shop || !token) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN env vars."
    );
  }

  const url = `https://${shop}/admin/api/2026-01/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    throw new Error(`GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function orderGid(orderIdNumber) {
  return `gid://shopify/Order/${orderIdNumber}`;
}

async function getOrderBasic(orderIdGid) {
  const q = `
    query OrderBasic($id: ID!) {
      order(id: $id) {
        id
        name
        tags
        fulfillmentOrders(first: 50) {
          nodes {
            id
            status
            requestStatus
          }
        }
      }
    }
  `;
  const data = await shopifyGraphql(q, { id: orderIdGid });
  return data.order;
}

async function addTagsToOrder(orderIdGid, tags) {
  const m = `
    mutation TagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(m, { id: orderIdGid, tags });
  const errs = data.tagsAdd?.userErrors || [];
  if (errs.length) throw new Error(`tagsAdd userErrors: ${JSON.stringify(errs)}`);
}

async function holdFulfillmentOrders(fulfillmentOrderIds, note = "Ordine in giacenza (Accumula da Nami!)") {
  // Se Shopify ti dovesse dare userErrors su reason, dimmelo e lo adattiamo al tuo shop.
  const m = `
    mutation Hold($id: ID!, $reason: FulfillmentHoldReason!, $reasonNotes: String) {
      fulfillmentOrderHold(id: $id, reason: $reason, reasonNotes: $reasonNotes) {
        fulfillmentOrder { id status }
        userErrors { field message }
      }
    }
  `;

  for (const foId of fulfillmentOrderIds) {
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

export default async function handler(req, res) {
  // Shopify invia i webhook via POST
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  // 1) Leggi il RAW body (stringa) così com'è arrivata
  const rawBody = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  // 2) Prendi HMAC header e secret giusto per i webhook
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    console.log("Missing env SHOPIFY_WEBHOOK_SECRET");
    return res.status(500).send("Server misconfigured");
  }

  if (!hmacHeader || typeof hmacHeader !== "string") {
    console.log("Missing or invalid x-shopify-hmac-sha256 header");
    return res.status(401).send("Missing HMAC header");
  }

  // 3) Calcola hash e confronta in modo sicuro
  const generatedHash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const hashBuf = Buffer.from(generatedHash, "utf8");
  const hmacBuf = Buffer.from(hmacHeader, "utf8");

  const valid =
    hashBuf.length === hmacBuf.length && crypto.timingSafeEqual(hashBuf, hmacBuf);

  if (!valid) {
    console.log("HMAC validation failed");
    return res.status(401).send("HMAC validation failed");
  }

  // 4) Ora puoi parseare il JSON
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.log("JSON parse failed", e);
    return res.status(400).send("Invalid JSON");
  }

  // 5) Log utile
  const topic = req.headers["x-shopify-topic"];
  const orderName = payload?.name || payload?.id;
  const shippingTitle = payload?.shipping_lines?.[0]?.title || "";
  const orderId = payload?.id;

  console.log("✅ Webhook OK");
  console.log("Topic:", topic);
  console.log("Order:", orderName);
  console.log("Shipping:", shippingTitle);

  // Se non è un ordine valido, chiudiamo
  if (!orderId) {
    return res.status(200).send("Webhook ricevuto (no order id)");
  }

  // === DA QUI PARTE LA LOGICA ACCUMULA / SDA ===
  try {
    const gid = orderGid(orderId);

    // prendiamo tags + fulfillmentOrders dal live order (via API)
    const live = await getOrderBasic(gid);
    const currentTags = (live?.tags || []).map((t) => t.trim());

    // CASO A — GIACENZA
    if (shippingTitle === SHIPPING_ACCUMULA) {
      if (!currentTags.includes(TAG_GIACENZA)) {
        await addTagsToOrder(gid, [TAG_GIACENZA]);
      }

      const foIds = (live?.fulfillmentOrders?.nodes || []).map((n) => n.id);
      if (foIds.length) {
        await holdFulfillmentOrders(foIds);
      }

      console.log("🧊 GIACENZA OK:", orderName);
      return res.status(200).send("OK GIACENZA");
    }

    // CASO B — SPEDIZIONE IMMEDIATA
    if (shippingTitle === SHIPPING_SDA) {
      // tag ordine trigger
      const tagsToAdd = [];
      if (!currentTags.includes(TAG_SPEDISCI_ORA)) tagsToAdd.push(TAG_SPEDISCI_ORA);

      // idempotenza: se già merge ok/in corso, non rifacciamo
      if (currentTags.includes(TAG_MERGE_OK) || currentTags.includes(TAG_MERGE_IN_CORSO)) {
        console.log("🔁 Merge già gestito/in corso, skip:", orderName);
        return res.status(200).send("SKIP already handled");
      }

      tagsToAdd.push(TAG_MERGE_IN_CORSO);

      if (tagsToAdd.length) {
        await addTagsToOrder(gid, tagsToAdd);
      }

      console.log("🚚 TRIGGER SDA OK:", orderName);
      // Qui nel prossimo step inseriamo:
      // - cerca ordini GIACENZA del cliente
      // - fulfillmentOrderMerge
      // - fulfillmentCreate
      return res.status(200).send("OK SDA (merge next step)");
    }

    console.log("ℹ️ Metodo spedizione non gestito:", shippingTitle);
    return res.status(200).send("OK (ignored shipping method)");
  } catch (err) {
    console.error("❌ Logic/API error:", err);
    // Rispondiamo 200 per evitare retry infiniti mentre stiamo sviluppando
    return res.status(200).send("ERROR handled");
  }
}



export const config = {
  api: {
    bodyParser: false, // IMPORTANT: serve per verificare l'HMAC sul raw body
  },
};

import crypto from "crypto";

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

  // timing-safe compare (evita bug e vulnerabilità)
  const hashBuf = Buffer.from(generatedHash, "utf8");
  const hmacBuf = Buffer.from(hmacHeader, "utf8");

  // Se lunghezze diverse, timingSafeEqual lancia errore: gestiamolo.
  const valid =
    hashBuf.length === hmacBuf.length && crypto.timingSafeEqual(hashBuf, hmacBuf);

  if (!valid) {
    console.log("HMAC validation failed", {
      generatedHash,
      hmacHeader,
    });
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
  console.log("✅ Webhook OK");
  console.log("Topic:", req.headers["x-shopify-topic"]);
  console.log("Order:", payload?.name || payload?.id);

  // 6) Risposta a Shopify
  return res.status(200).send("Webhook ricevuto");
}


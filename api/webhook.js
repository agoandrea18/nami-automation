export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const rawBody = await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(data);
    });
  });

  const hmac = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_API_SECRET;

  const generatedHash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  if (generatedHash !== hmac) {
    return res.status(401).send("HMAC validation failed");
  }

  const order = JSON.parse(rawBody);

  console.log("Ordine ricevuto:", order.name);

  return res.status(200).send("Webhook ricevuto");
}

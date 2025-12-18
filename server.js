import express from "express";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Helpers
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function basicAuthHeader(user, pass) {
  const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function jsonError(res, status, message, details) {
  return res.status(status).json({ ok: false, error: message, details: details ?? null });
}

/**
 * SAV Extract (image -> JSON)
 */
app.post("/sav/extract", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return jsonError(res, 400, "missing image");

    const b64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype};base64,${b64}`;

    const response = await openai.responses.create({
      model: "gpt-5-nano",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Tu es un extracteur d’informations SAV.",
                "Entrée: une capture d’écran d’un email SAV.",
                "Retourne UNIQUEMENT un JSON valide avec ce schéma:",
                "{",
                '  "customer": { "email": null },',
                '  "order": { "order_number": null },',
                '  "shipment": { "tracking_number": null },',
                '  "signals": { "best_key": null, "has_enough": false }',
                "}",
                "Règles:",
                "- N’invente rien. Si absent ou incertain: null.",
                "- best_key = tracking_number si tracking_number non-null, sinon order_number, sinon email, sinon null.",
                "- has_enough = true si best_key != null, sinon false.",
                "Ne renvoie aucun texte hors JSON."
              ].join("\n")
            },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    });

    const text = response.output_text?.trim() ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonError(res, 502, "model_did_not_return_json", text.slice(0, 800));
    }
    return res.json(parsed);
  } catch (e) {
    return jsonError(res, 500, "sav_extract_failed", String(e?.message || e));
  }
});

/**
 * WooCommerce
 */
async function wooFetchOrdersLatest(perPage = 50) {
  const base = requireEnv("WC_BASE_URL").replace(/\/$/, "");
  const ck = requireEnv("WC_CONSUMER_KEY");
  const cs = requireEnv("WC_CONSUMER_SECRET");

  const url = new URL(`${base}/wp-json/wc/v3/orders`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");

  const r = await fetch(url.toString(), {
    headers: {
      Authorization: basicAuthHeader(ck, cs),
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Woo orders fetch failed: ${r.status} ${text}`);
  }

  return await r.json();
}

function pickOrderNumber(order) {
  if (order && order.number != null) return String(order.number);
  if (order && order.id != null) return String(order.id);
  return null;
}

function extractTrackingFromOrderMeta(order) {
  const keys = (process.env.TRACKING_META_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!keys.length) return null;

  const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  for (const k of keys) {
    const hit = meta.find((m) => m?.key === k && m?.value != null && String(m.value).trim() !== "");
    if (hit) return String(hit.value).trim();
  }
  return null;
}

async function wooLookupByEmail(email) {
  const perPage = Number(process.env.ORDER_LOOKBACK_PER_PAGE || 50);
  const orders = await wooFetchOrdersLatest(perPage);

  const normalized = String(email || "").trim().toLowerCase();
  const matches = orders.filter(
    (o) => String(o?.billing?.email || "").trim().toLowerCase() === normalized
  );

  if (!matches.length) return { order_number: null, order_id: null, tracking_number: null };

  const latest = matches[0];
  const order_number = pickOrderNumber(latest);
  const order_id = latest?.id ?? null;
  const tracking_number = extractTrackingFromOrderMeta(latest);

  return { order_number, order_id, tracking_number: tracking_number ?? null };
}

/**
 * Sendcloud
 */
async function sendcloudGet(path) {
  const pub = requireEnv("SENDCLOUD_PUBLIC_KEY");
  const sec = requireEnv("SENDCLOUD_SECRET_KEY");

  const url = `https://panel.sendcloud.sc${path}`;
  const r = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(pub, sec),
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Sendcloud GET failed: ${r.status} ${text}`);
  }
  return await r.json();
}

async function sendcloudFindParcelByOrderNumber(order_number) {
  const q = encodeURIComponent(String(order_number));
  return await sendcloudGet(`/api/v2/parcels?order_number=${q}`);
}

async function sendcloudTrackByTrackingNumber(tracking_number) {
  const tn = encodeURIComponent(String(tracking_number));
  return await sendcloudGet(`/api/v2/tracking/${tn}`);
}

function pickTrackingNumberFromParcelsResponse(payload) {
  // Correction: ton code avait un bug de priorité avec "?:".
  // Ici on choisit explicitement la première liste plausible.
  const candidates =
    payload?.parcels ??
    payload?.results ??
    payload?.data ??
    (payload?.parcel ? [payload.parcel] : []);

  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;

  const first = list[0];
  if (first?.tracking_number) return String(first.tracking_number);
  if (first?.tracking?.tracking_number) return String(first.tracking.tracking_number);

  return null;
}

/**
 * Endpoints
 */
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/woo/lookup", async (req, res) => {
  try {
    const email = req.body?.email;
    if (!email) return jsonError(res, 400, "Missing email");
    const out = await wooLookupByEmail(email);
    return res.json({ ok: true, ...out });
  } catch (e) {
    return jsonError(res, 500, "Woo lookup failed", String(e?.message || e));
  }
});

app.post("/sendcloud/by-order-number", async (req, res) => {
  try {
    const order_number = req.body?.order_number;
    if (!order_number) return jsonError(res, 400, "Missing order_number");
    const parcels = await sendcloudFindParcelByOrderNumber(order_number);
    const tracking_number = pickTrackingNumberFromParcelsResponse(parcels);
    return res.json({ ok: true, order_number: String(order_number), tracking_number, parcels });
  } catch (e) {
    return jsonError(res, 500, "Sendcloud by-order-number failed", String(e?.message || e));
  }
});

app.post("/sendcloud/by-tracking", async (req, res) => {
  try {
    const tracking_number = req.body?.tracking_number;
    if (!tracking_number) return jsonError(res, 400, "Missing tracking_number");
    const tracking = await sendcloudTrackByTrackingNumber(tracking_number);
    return res.json({ ok: true, tracking_number: String(tracking_number), tracking });
  } catch (e) {
    return jsonError(res, 500, "Sendcloud tracking failed", String(e?.message || e));
  }
});

app.post("/sav/resolve", async (req, res) => {
  try {
    const extracted = req.body?.extracted;
    if (!extracted) return jsonError(res, 400, "Missing extracted");

    const email = extracted?.customer?.email ?? null;
    const order_number_in = extracted?.order?.order_number ?? null;
    const tracking_in = extracted?.shipment?.tracking_number ?? null;

    if (tracking_in) {
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      return res.json({
        ok: true,
        path: "tracking_number",
        email,
        order_number: order_number_in,
        tracking_number: tracking_in,
        tracking
      });
    }

    if (order_number_in) {
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      if (!tn) {
        return res.json({
          ok: true,
          path: "order_number_no_tracking",
          email,
          order_number: order_number_in,
          tracking_number: null,
          parcels
        });
      }
      const tracking = await sendcloudTrackByTrackingNumber(tn);
      return res.json({
        ok: true,
        path: "order_number",
        email,
        order_number: order_number_in,
        tracking_number: tn,
        parcels,
        tracking
      });
    }

    if (email) {
      const woo = await wooLookupByEmail(email);

      if (woo.tracking_number) {
        const tracking = await sendcloudTrackByTrackingNumber(woo.tracking_number);
        return res.json({
          ok: true,
          path: "email->woo(tracking)",
          email,
          order_number: woo.order_number,
          tracking_number: woo.tracking_number,
          woo,
          tracking
        });
      }

      if (woo.order_number) {
        const parcels = await sendcloudFindParcelByOrderNumber(woo.order_number);
        const tn = pickTrackingNumberFromParcelsResponse(parcels);
        if (!tn) {
          return res.json({
            ok: true,
            path: "email->woo(order)->sendcloud(no_tracking)",
            email,
            order_number: woo.order_number,
            tracking_number: null,
            woo,
            parcels
          });
        }
        const tracking = await sendcloudTrackByTrackingNumber(tn);
        return res.json({
          ok: true,
          path: "email->woo(order)->sendcloud->tracking",
          email,
          order_number: woo.order_number,
          tracking_number: tn,
          woo,
          parcels,
          tracking
        });
      }

      return res.json({
        ok: true,
        path: "email_no_order_found",
        email,
        order_number: null,
        tracking_number: null,
        woo
      });
    }

    return res.json({ ok: true, path: "no_identifiers", email: null, order_number: null, tracking_number: null });
  } catch (e) {
    return jsonError(res, 500, "SAV resolve failed", String(e?.message || e));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));

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

// --- LOGIQUE MÉTIER EXTRAITE (POUR ÊTRE RÉUTILISÉE) ---

async function extractDataFromImage(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Tu es un extracteur d’informations SAV. Tu retournes toujours du JSON valide."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
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
                "- has_enough = true si best_key != null, sinon false."
              ].join("\n")
            },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    const text = response.choices[0].message.content?.trim() ?? "";
    return JSON.parse(text);
}

async function resolveTrackingLogic(extracted) {
    const email = extracted?.customer?.email ?? null;
    const order_number_in = extracted?.order?.order_number ?? null;
    const tracking_in = extracted?.shipment?.tracking_number ?? null;

    // 1. Si on a déjà le tracking
    if (tracking_in) {
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      return {
        path: "tracking_number",
        email,
        order_number: order_number_in,
        tracking_number: tracking_in,
        tracking
      };
    }

    // 2. Si on a le numéro de commande
    if (order_number_in) {
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      if (!tn) {
        return {
          path: "order_number_no_tracking",
          email,
          order_number: order_number_in,
          tracking_number: null,
          parcels
        };
      }
      const tracking = await sendcloudTrackByTrackingNumber(tn);
      return {
        path: "order_number",
        email,
        order_number: order_number_in,
        tracking_number: tn,
        parcels,
        tracking
      };
    }

    // 3. Si on a l'email -> WooCommerce -> Sendcloud
    if (email) {
      const woo = await wooLookupByEmail(email);

      if (woo.tracking_number) {
        const tracking = await sendcloudTrackByTrackingNumber(woo.tracking_number);
        return {
          path: "email->woo(tracking)",
          email,
          order_number: woo.order_number,
          tracking_number: woo.tracking_number,
          woo,
          tracking
        };
      }

      if (woo.order_number) {
        const parcels = await sendcloudFindParcelByOrderNumber(woo.order_number);
        const tn = pickTrackingNumberFromParcelsResponse(parcels);
        if (!tn) {
          return {
            path: "email->woo(order)->sendcloud(no_tracking)",
            email,
            order_number: woo.order_number,
            tracking_number: null,
            woo,
            parcels
          };
        }
        const tracking = await sendcloudTrackByTrackingNumber(tn);
        return {
          path: "email->woo(order)->sendcloud->tracking",
          email,
          order_number: woo.order_number,
          tracking_number: tn,
          woo,
          parcels,
          tracking
        };
      }

      return {
        path: "email_no_order_found",
        email,
        order_number: null,
        tracking_number: null,
        woo
      };
    }

    return { path: "no_identifiers", email: null, order_number: null, tracking_number: null };
}

// --- ROUTES ---

/**
 * LA ROUTE MAGIQUE (Celle que tu dois appeler depuis Rails)
 * Entrée : Image
 * Sortie : Tracking complet
 */
app.post("/sav/process", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return jsonError(res, 400, "missing image");
    
    // 1. Extraction (IA)
    const extracted = await extractDataFromImage(req.file);
    
    // 2. Résolution (Woo/Sendcloud)
    const result = await resolveTrackingLogic(extracted);
    
    // 3. Retourne tout
    return res.json({ ok: true, extracted, result });
    
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "sav_process_failed", String(e?.message || e));
  }
});


// Ancienne route (juste pour tester l'extraction si besoin)
app.post("/sav/extract", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return jsonError(res, 400, "missing image");
    const extracted = await extractDataFromImage(req.file);
    return res.json(extracted);
  } catch (e) {
    return jsonError(res, 500, "sav_extract_failed", String(e?.message || e));
  }
});

// Ancienne route (si on veut résoudre manuellement un JSON)
app.post("/sav/resolve", async (req, res) => {
  try {
    const extracted = req.body?.extracted;
    if (!extracted) return jsonError(res, 400, "Missing extracted");
    const result = await resolveTrackingLogic(extracted);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return jsonError(res, 500, "SAV resolve failed", String(e?.message || e));
  }
});

/**
 * WooCommerce Implementation
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
 * Sendcloud Implementation
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
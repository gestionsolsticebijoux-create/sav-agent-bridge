import express from "express";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "2mb" }));

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
 * WooCommerce
 */
async function wooFetchOrdersLatest(perPage = 50) {
  const base = requireEnv("WC_BASE_URL").replace(/\/$/, "");
  const ck = requireEnv("WC_CONSUMER_KEY");
  const cs = requireEnv("WC_CONSUMER_SECRET");

  // NOTE: On évite d’affirmer l’existence d’un filtre officiel "billing_email".
  // On récupère les dernières commandes puis on filtre strictement côté serveur.
  const url = new URL(`${base}/wp-json/wc/v3/orders`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");

  const r = await fetch(url.toString(), {
    headers: {
      "Authorization": basicAuthHeader(ck, cs),
      "Accept": "application/json"
    }
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Woo orders fetch failed: ${r.status} ${text}`);
  }

  return await r.json();
}

function pickOrderNumber(order) {
  // Woo REST renvoie typiquement "number" (string) + "id" (int).
  // On préfère "number" si présent, sinon fallback sur "id".
  if (order && order.number != null) return String(order.number);
  if (order && order.id != null) return String(order.id);
  return null;
}

function extractTrackingFromOrderMeta(order) {
  // Pas standard WooCommerce => dépend d’un plugin.
  // On ne devine pas : on ne cherche que dans une liste explicite de clés meta.
  const keys = (process.env.TRACKING_META_KEYS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!keys.length) return null;
  const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  for (const k of keys) {
    const hit = meta.find(m => m?.key === k && m?.value != null && String(m.value).trim() !== "");
    if (hit) return String(hit.value).trim();
  }
  return null;
}

async function wooLookupByEmail(email) {
  const perPage = Number(process.env.ORDER_LOOKBACK_PER_PAGE || 50);
  const orders = await wooFetchOrdersLatest(perPage);

  const normalized = String(email || "").trim().toLowerCase();
  const matches = orders.filter(o => String(o?.billing?.email || "").trim().toLowerCase() === normalized);

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
      "Authorization": basicAuthHeader(pub, sec),
      "Accept": "application/json"
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
  // Doc: GET /api/v2/parcels?order_number=... :contentReference[oaicite:4]{index=4}
  return await sendcloudGet(`/api/v2/parcels?order_number=${q}`);
}

async function sendcloudTrackByTrackingNumber(tracking_number) {
  const tn = encodeURIComponent(String(tracking_number));
  // Doc: GET /api/v2/tracking/{tracking_number} :contentReference[oaicite:5]{index=5}
  return await sendcloudGet(`/api/v2/tracking/${tn}`);
}

function pickTrackingNumberFromParcelsResponse(payload) {
  // Sendcloud peut renvoyer une liste; on fait une lecture défensive.
  // On ne devine pas : on cherche un champ "tracking_number" dans la première entrée plausible.
  const candidates =
    payload?.parcels ||
    payload?.results ||
    payload?.data ||
    payload?.parcel ? [payload.parcel] : null;

  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;

  const first = list[0];
  if (first?.tracking_number) return String(first.tracking_number);

  // Certains payloads embed un objet "tracking".
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

/**
 * /sav/resolve
 * Entrée possible:
 * - JSON { extracted: { customer:{email}, order:{order_number}, shipment:{tracking_number}, signals:{best_key}} }
 * - ou multipart form-data avec champ "image" (si tu veux que ce endpoint appelle ton /sav/extract existant)
 *
 * Ici, je fournis la version JSON-only (zéro dépendance sur ton code existant).
 * Tu peux ensuite faire appeler /sav/extract en amont (iPhone) et passer son JSON ici.
 */
app.post("/sav/resolve", async (req, res) => {
  try {
    const extracted = req.body?.extracted;
    if (!extracted) return jsonError(res, 400, "Missing extracted");

    const email = extracted?.customer?.email ?? null;
    const order_number_in = extracted?.order?.order_number ?? null;
    const tracking_in = extracted?.shipment?.tracking_number ?? null;

    // 1) Si tracking => tracking direct
    if (tracking_in) {
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      return res.json({ ok: true, path: "tracking_number", email, order_number: order_number_in, tracking_number: tracking_in, tracking });
    }

    // 2) Si order_number => parcels -> tracking -> tracking detail
    if (order_number_in) {
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      if (!tn) {
        return res.json({ ok: true, path: "order_number_no_tracking", email, order_number: order_number_in, tracking_number: null, parcels });
      }
      const tracking = await sendcloudTrackByTrackingNumber(tn);
      return res.json({ ok: true, path: "order_number", email, order_number: order_number_in, tracking_number: tn, parcels, tracking });
    }

    // 3) Sinon email => Woo lookup => (tracking via meta ou order_number => sendcloud)
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

      return res.json({ ok: true, path: "email_no_order_found", email, order_number: null, tracking_number: null, woo });
    }

    return res.json({ ok: true, path: "no_identifiers", email: null, order_number: null, tracking_number: null });
  } catch (e) {
    return jsonError(res, 500, "SAV resolve failed", String(e?.message || e));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));

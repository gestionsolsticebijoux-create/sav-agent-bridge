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

// --- LOGIQUE MÉTIER ---

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

// Nouvelle logique de résolution avec logs (trace)
async function resolveTrackingLogic(extracted) {
    const logs = []; // On va stocker l'histoire ici
    const email = extracted?.customer?.email ?? null;
    const order_number_in = extracted?.order?.order_number ?? null;
    const tracking_in = extracted?.shipment?.tracking_number ?? null;

    logs.push(`Début analyse. Données entrantes : Email=${email}, Order=${order_number_in}, Tracking=${tracking_in}`);

    // CAS 1 : On a déjà le tracking
    if (tracking_in) {
      logs.push("Tracking trouvé directement par l'IA. Interrogation Sendcloud...");
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      logs.push(`Statut Sendcloud reçu : ${tracking?.status?.id || "inconnu"}`);
      
      return {
        logs,
        path: "tracking_number_direct",
        final_status: tracking,
        tracking_number: tracking_in
      };
    }

    // CAS 2 : On a le numéro de commande
    if (order_number_in) {
      logs.push(`Numéro de commande ${order_number_in} trouvé. Recherche colis Sendcloud...`);
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      
      if (!tn) {
        logs.push("Aucun colis/tracking trouvé dans Sendcloud pour cette commande.");
        return {
          logs,
          path: "order_number_found_but_no_parcel",
          final_status: null,
          tracking_number: null,
          parcels_debug: parcels
        };
      }
      
      logs.push(`Tracking ${tn} découvert via Sendcloud. Récupération statut...`);
      const tracking = await sendcloudTrackByTrackingNumber(tn);
      return {
        logs,
        path: "order_number_resolved",
        final_status: tracking,
        tracking_number: tn
      };
    }

    // CAS 3 : On a l'email -> WooCommerce -> Sendcloud
    if (email) {
      logs.push(`Email ${email} trouvé. Recherche commande dans WooCommerce...`);
      
      // Ici on utilise la nouvelle fonction optimisée
      const woo = await wooLookupByEmailStart(email);
      
      if (!woo.order_number) {
        logs.push("WooCommerce n'a retourné aucune commande pour cet email.");
        return {
          logs,
          path: "email_found_but_no_order_in_woo",
          final_status: null,
          tracking_number: null
        };
      }

      logs.push(`Commande WooCommerce trouvée : #${woo.order_number}. Vérification métadonnées tracking...`);

      if (woo.tracking_number) {
        logs.push(`Tracking ${woo.tracking_number} trouvé dans les métadonnées Woo. Interrogation Sendcloud...`);
        const tracking = await sendcloudTrackByTrackingNumber(woo.tracking_number);
        return {
          logs,
          path: "email_resolved_via_woo_meta",
          final_status: tracking,
          tracking_number: woo.tracking_number
        };
      }

      logs.push("Pas de tracking dans Woo. Recherche colis Sendcloud avec le numéro de commande...");
      const parcels = await sendcloudFindParcelByOrderNumber(woo.order_number);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);

      if (!tn) {
        logs.push("Sendcloud ne trouve aucun colis pour ce numéro de commande.");
        return {
          logs,
          path: "email_found_order_found_but_no_parcel",
          final_status: null,
          tracking_number: null
        };
      }

      logs.push(`Tracking ${tn} trouvé via Sendcloud. Récupération statut final...`);
      const tracking = await sendcloudTrackByTrackingNumber(tn);
      return {
        logs,
        path: "email_resolved_via_sendcloud_lookup",
        final_status: tracking,
        tracking_number: tn
      };
    }

    logs.push("Aucune donnée exploitable (ni email, ni commande, ni tracking).");
    return { logs, path: "no_identifiers", final_status: null, tracking_number: null };
}

// --- ROUTES ---

app.post("/sav/process", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return jsonError(res, 400, "missing image");
    
    // 1. Extraction (IA)
    const extracted = await extractDataFromImage(req.file);
    
    // 2. Résolution (Woo/Sendcloud) avec Logs
    const result = await resolveTrackingLogic(extracted);
    
    // 3. Retourne tout
    return res.json({ ok: true, extracted, resolution: result });
    
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "sav_process_failed", String(e?.message || e));
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));


/**
 * WooCommerce Implementation (OPTIMISÉE)
 */
async function wooFetchOrdersBySearch(term) {
  const base = requireEnv("WC_BASE_URL").replace(/\/$/, "");
  const ck = requireEnv("WC_CONSUMER_KEY");
  const cs = requireEnv("WC_CONSUMER_SECRET");

  const url = new URL(`${base}/wp-json/wc/v3/orders`);
  url.searchParams.set("search", term); // <-- C'est ici la magie : on cherche précisément
  url.searchParams.set("per_page", "10"); // On limite à 10 résultats pertinents

  const r = await fetch(url.toString(), {
    headers: {
      Authorization: basicAuthHeader(ck, cs),
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Woo search failed: ${r.status} ${text}`);
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

// Nouvelle fonction qui cherche VRAIMENT l'email
async function wooLookupByEmailStart(email) {
  const orders = await wooFetchOrdersBySearch(email);

  if (!orders.length) return { order_number: null, order_id: null, tracking_number: null };

  // On prend la commande la plus récente retournée par la recherche
  const latest = orders[0];
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
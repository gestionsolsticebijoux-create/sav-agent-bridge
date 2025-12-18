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

/**
 * Fonction d'appel OpenAI générique pour gérer le retry de modèle
 */
async function callOpenAIWithFallback(messages, preferredModel = "gpt-5-nano") {
    try {
        // Tentative avec le modèle demandé (gpt-5-nano)
        const response = await openai.chat.completions.create({
            model: preferredModel,
            response_format: { type: "json_object" },
            messages: messages
        });
        return response;
    } catch (e) {
        // Si le modèle n'existe pas (404) ou autre erreur API, on fallback sur gpt-4o-mini
        console.warn(`⚠️ ${preferredModel} a échoué (${e.status || e.message}). Bascule sur gpt-4o-mini.`);
        return await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: messages
        });
    }
}

async function extractDataFromImage(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const messages = [
        {
          role: "system",
          content: "Tu es un extracteur d’informations SAV expert. Tu analyses des preuves visuelles (Email, WhatsApp, SMS)."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "CONTEXTE: L'utilisateur envoie une capture d'écran (WhatsApp, SMS, Email) pour retrouver une commande.",
                "TA MISSION : Scanner l'image ENTIÈRE (y compris les en-têtes/headers d'application) pour trouver des identifiants.",
                "",
                "Retourne UNIQUEMENT ce JSON :",
                "{",
                '  "customer": { "email": null, "phone": null },',
                '  "order": { "order_number": null },',
                '  "shipment": { "tracking_number": null },',
                '  "signals": { "best_key": null, "has_enough": false }',
                "}",
                "",
                "RÈGLES STRICTES :",
                "1. TÉLÉPHONE (Crucial) :",
                "   - Regarde attentivement le HAUT de l'image (Barre de titre WhatsApp/SMS).",
                "   - Si un numéro apparaît (ex: +33 6..., 06...), extrais-le.",
                "   - Formate-le simplement (ex: 0612345678 ou 33612345678). Enlève les espaces et les tirets.",
                "2. EMAIL : Cherche dans le corps ou l'expéditeur.",
                "3. N’invente rien. Si absent: null.",
                "4. best_key = tracking > order > email > phone.",
                "5. has_enough = true si au moins une clé est trouvée."
              ].join("\n")
            },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
    ];

    // Appel avec GPT-5-NANO (et fallback gpt-4o-mini si besoin)
    const response = await callOpenAIWithFallback(messages, "gpt-5-nano");

    const text = response.choices[0].message.content?.trim() ?? "";
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("Invalid JSON response from AI");
    
    return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
}

// Logique de résolution (Email OU Téléphone avec Retry 33 vs 0)
async function resolveTrackingLogic(extracted) {
    const logs = [];
    const email = extracted?.customer?.email ?? null;
    const phone = extracted?.customer?.phone ?? null;
    const order_number_in = extracted?.order?.order_number ?? null;
    const tracking_in = extracted?.shipment?.tracking_number ?? null;

    logs.push(`Début analyse. Email=${email}, Phone=${phone}, Order=${order_number_in}, Tracking=${tracking_in}`);

    // 1. Tracking direct
    if (tracking_in) {
      logs.push("Tracking trouvé directement. Interrogation Sendcloud...");
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      return { logs, path: "tracking_number_direct", final_status: tracking, tracking_number: tracking_in };
    }

    // 2. Numéro de commande direct
    if (order_number_in) {
      logs.push(`Numéro de commande ${order_number_in} trouvé. Recherche colis Sendcloud...`);
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      
      if (!tn) {
        logs.push("Aucun colis trouvé avec ce numéro de commande.");
        return { logs, path: "order_number_found_no_parcel", final_status: null, tracking_number: null };
      }
      
      const tracking = await sendcloudTrackByTrackingNumber(tn);
      return { logs, path: "order_number_resolved", final_status: tracking, tracking_number: tn };
    }

    // 3. Recherche via Email
    if (email) {
      logs.push(`Recherche commande WooCommerce via Email : ${email}`);
      const result = await tryResolveViaWooSearch(email, logs);
      if (result) return { ...result, path: "resolved_via_email" };
      logs.push("Échec résolution via Email. On continue...");
    }

    // 4. Recherche via Téléphone (INTELLIGENT)
    if (phone) {
      // Nettoyage de base
      let cleanPhone = phone.replace(/\D/g, ''); 
      
      // Tentative 1 : Le numéro tel quel
      logs.push(`Recherche Tel #1 (Format brut) : ${cleanPhone}`);
      let result = await tryResolveViaWooSearch(cleanPhone, logs);
      if (result) return { ...result, path: "resolved_via_phone_exact" };

      // Tentative 2 : Si commence par 33, remplacer par 0
      if (cleanPhone.startsWith('33') && cleanPhone.length > 9) {
          let localPhone = '0' + cleanPhone.substring(2);
          logs.push(`Recherche Tel #2 (Format FR '0...') : ${localPhone}`);
          result = await tryResolveViaWooSearch(localPhone, logs);
          if (result) return { ...result, path: "resolved_via_phone_localized" };
      }

      // Tentative 3 : Si commence par 0, remplacer par 33 (cas inverse)
      if (cleanPhone.startsWith('0') && cleanPhone.length > 9) {
          let interPhone = '33' + cleanPhone.substring(1);
          logs.push(`Recherche Tel #3 (Format INT '33...') : ${interPhone}`);
          result = await tryResolveViaWooSearch(interPhone, logs);
          if (result) return { ...result, path: "resolved_via_phone_international" };
      }

      logs.push("Échec résolution via Téléphone après toutes les tentatives.");
    }

    logs.push("Aucune identification possible.");
    return { logs, path: "no_identifiers", final_status: null, tracking_number: null };
}

async function tryResolveViaWooSearch(searchTerm, logs) {
    const woo = await wooLookupBySearchTerm(searchTerm);

    if (!woo.order_number) {
        return null;
    }

    logs.push(`WooCommerce : Commande #${woo.order_number} trouvée avec "${searchTerm}" !`);

    if (woo.tracking_number) {
        logs.push(`Tracking ${woo.tracking_number} lu dans Woo. Verify Sendcloud...`);
        const tracking = await sendcloudTrackByTrackingNumber(woo.tracking_number);
        return { logs, final_status: tracking, tracking_number: woo.tracking_number };
    }

    logs.push("Pas de tracking dans Woo. Check Sendcloud via Order Number...");
    const parcels = await sendcloudFindParcelByOrderNumber(woo.order_number);
    const tn = pickTrackingNumberFromParcelsResponse(parcels);

    if (tn) {
        logs.push(`Tracking ${tn} trouvé via Sendcloud !`);
        const tracking = await sendcloudTrackByTrackingNumber(tn);
        return { logs, final_status: tracking, tracking_number: tn };
    }

    return null;
}

// --- ROUTES ---

app.post("/sav/process", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return jsonError(res, 400, "missing image");
    const extracted = await extractDataFromImage(req.file);
    const result = await resolveTrackingLogic(extracted);
    return res.json({ ok: true, extracted, resolution: result });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "sav_process_failed", String(e?.message || e));
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * WooCommerce Implementation
 */
async function wooFetchOrdersBySearch(term) {
  const base = requireEnv("WC_BASE_URL").replace(/\/$/, "");
  const ck = requireEnv("WC_CONSUMER_KEY");
  const cs = requireEnv("WC_CONSUMER_SECRET");

  const url = new URL(`${base}/wp-json/wc/v3/orders`);
  url.searchParams.set("search", term);
  url.searchParams.set("per_page", "5");

  const r = await fetch(url.toString(), {
    headers: { Authorization: basicAuthHeader(ck, cs), Accept: "application/json" }
  });

  if (!r.ok) throw new Error(`Woo search failed: ${r.status}`);
  return await r.json();
}

function pickOrderNumber(order) {
  if (order && order.number != null) return String(order.number);
  if (order && order.id != null) return String(order.id);
  return null;
}

function extractTrackingFromOrderMeta(order) {
  const keys = (process.env.TRACKING_META_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!keys.length) return null;
  const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  for (const k of keys) {
    const hit = meta.find((m) => m?.key === k && m?.value != null && String(m.value).trim() !== "");
    if (hit) return String(hit.value).trim();
  }
  return null;
}

async function wooLookupBySearchTerm(term) {
  const orders = await wooFetchOrdersBySearch(term);
  if (!orders.length) return { order_number: null, order_id: null, tracking_number: null };

  const latest = orders[0];
  return {
    order_number: pickOrderNumber(latest),
    order_id: latest?.id ?? null,
    tracking_number: extractTrackingFromOrderMeta(latest) ?? null
  };
}

/**
 * Sendcloud Implementation
 */
async function sendcloudGet(path) {
  const pub = requireEnv("SENDCLOUD_PUBLIC_KEY");
  const sec = requireEnv("SENDCLOUD_SECRET_KEY");
  const r = await fetch(`https://panel.sendcloud.sc${path}`, {
    headers: { Authorization: basicAuthHeader(pub, sec), Accept: "application/json" }
  });
  if (!r.ok) throw new Error(`Sendcloud GET failed: ${r.status}`);
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
  const candidates = payload?.parcels ?? payload?.results ?? payload?.data ?? (payload?.parcel ? [payload.parcel] : []);
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;
  const first = list[0];
  return first?.tracking_number || first?.tracking?.tracking_number || null;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
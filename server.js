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

// --- ÉTAPE 1 : L'ŒIL (Classification + Extraction) ---

async function extractAndClassify(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Très capable pour ça
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Tu es un expert SAV. Tu analyses une capture d'écran (Email, WhatsApp, SMS)."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "ANALYSE CETTE IMAGE ET RETOURNE CE JSON STRICT:",
                "{",
                '  "intent": {',
                '     "needs_tracking": boolean, // TRUE si le client demande où est son colis, signale un retard, ou demande le suivi.',
                '     "customer_first_name": string | null // Le prénom du client si visible (ex: "Bonjour Julie")',
                '  },',
                '  "identifiers": {',
                '     "email": null,',
                '     "phone": null, // Regarde bien en HAUT de l\'image (Header WhatsApp)',
                '     "order_number": null,',
                '     "tracking_number": null',
                '  }',
                "}",
                "RÈGLES IDENTIFIANTS:",
                "- Phone: Extrais les chiffres (ex: 336... ou 06...), nettoie les espaces.",
                "- Email: Cherche bien partout.",
                "- N'invente rien."
              ].join("\n")
            },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    const text = response.choices[0].message.content?.trim() ?? "";
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("Invalid JSON response from AI");
    
    return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
}

// --- ÉTAPE 2 : LE CERVEAU (Logique de recherche) ---
// (C'est la même logique robuste que tout à l'heure)

async function resolveTrackingLogic(identifiers) {
    const logs = [];
    const email = identifiers?.email ?? null;
    const phone = identifiers?.phone ?? null;
    const order_number_in = identifiers?.order_number ?? null;
    const tracking_in = identifiers?.tracking_number ?? null;

    logs.push(`🔍 Recherche: Email=${email}, Phone=${phone}, Order=${order_number_in}`);

    // 1. Tracking direct
    if (tracking_in) {
      logs.push("Tracking direct trouvé.");
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      return { logs, source: "tracking_number", data: tracking, tracking_number: tracking_in, woo_order: null };
    }

    // 2. Numéro de commande
    if (order_number_in) {
      logs.push("Commande directe trouvée.");
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      if (tn) {
          const tracking = await sendcloudTrackByTrackingNumber(tn);
          return { logs, source: "order_number", data: tracking, tracking_number: tn, woo_order: null }; // On pourrait fetch woo ici si besoin du prénom
      }
    }

    // 3. Email
    if (email) {
      logs.push("Recherche via Email.");
      const res = await tryResolveViaWooSearch(email, logs);
      if (res) return { ...res, source: "email" };
    }

    // 4. Téléphone (Avec retry intelligent)
    if (phone) {
      let cleanPhone = phone.replace(/\D/g, ''); 
      logs.push(`Recherche Tel: ${cleanPhone}`);
      
      let res = await tryResolveViaWooSearch(cleanPhone, logs);
      if (res) return { ...res, source: "phone_exact" };

      if (cleanPhone.startsWith('33') && cleanPhone.length > 9) {
          let local = '0' + cleanPhone.substring(2);
          res = await tryResolveViaWooSearch(local, logs);
          if (res) return { ...res, source: "phone_localized" };
      }
      if (cleanPhone.startsWith('0') && cleanPhone.length > 9) {
          let inter = '33' + cleanPhone.substring(1);
          res = await tryResolveViaWooSearch(inter, logs);
          if (res) return { ...res, source: "phone_international" };
      }
    }

    return { logs, source: "not_found", data: null, tracking_number: null, woo_order: null };
}

async function tryResolveViaWooSearch(term, logs) {
    const woo = await wooLookupBySearchTerm(term);
    if (!woo.order_number) return null;

    logs.push(`WooCommerce: Commande #${woo.order_number} trouvée.`);

    // On retourne l'objet complet Woo pour avoir le prénom enregistré dans la commande !
    const wooOrderFull = await wooFetchOrderById(woo.order_number); 

    // Stratégie Tracking
    let tn = woo.tracking_number;
    if (!tn) {
        const parcels = await sendcloudFindParcelByOrderNumber(woo.order_number);
        tn = pickTrackingNumberFromParcelsResponse(parcels);
    }

    if (tn) {
        const tracking = await sendcloudTrackByTrackingNumber(tn);
        return { logs, data: tracking, tracking_number: tn, woo_order: wooOrderFull };
    }
    
    // Cas où on a la commande mais pas encore de tracking (ex: en prépa)
    return { logs, data: null, tracking_number: null, woo_order: wooOrderFull, status: "processing_no_tracking" };
}

// --- ÉTAPE 3 : LE SYNTHÉTISEUR (Simplification) ---

function simplifyContext(iaResult, resolutionResult) {
    // 1. Trouver le prénom (Priorité : WooCommerce > IA > "Client")
    let firstName = "Client";
    if (resolutionResult?.woo_order?.billing?.first_name) {
        firstName = resolutionResult.woo_order.billing.first_name;
    } else if (iaResult?.intent?.customer_first_name) {
        firstName = iaResult.intent.customer_first_name;
    }

    // 2. Extraire les infos de suivi
    const trackingData = resolutionResult?.data;
    const trackingNumber = resolutionResult?.tracking_number;
    
    // Sendcloud donne souvent une URL générique, on essaie de trouver la meilleure
    const trackingLink = trackingData?.carrier_tracking_url 
                      || trackingData?.sendcloud_tracking_url 
                      || (trackingNumber ? `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}` : null);

    // 3. Historique simplifié (Les 3 derniers statuts)
    let history = [];
    if (trackingData?.statuses && Array.isArray(trackingData.statuses)) {
        history = trackingData.statuses
            .slice(-3) // Prendre les 3 derniers
            .map(s => ` - ${s.carrier_message || s.status} (${s.carrier_update_timestamp || "Date inconnue"})`)
            .reverse();
    }

    const currentStatus = trackingData?.status?.message || trackingData?.carrier_status || "Inconnu";

    return {
        first_name: firstName,
        tracking_number: trackingNumber,
        tracking_link: trackingLink,
        current_status: currentStatus,
        history: history.join("\n"),
        is_found: !!trackingNumber
    };
}

// --- ÉTAPE 4 : LA PLUME (Rédaction) ---

async function draftResponse(simplifiedData) {
    if (!simplifiedData.is_found) {
        return `Bonjour ${simplifiedData.first_name},\n\nJe n'ai pas réussi à retrouver votre commande avec les informations visibles. Pourriez-vous me donner votre numéro de commande ou l'email utilisé lors de l'achat ?\n\nMerci !`;
    }

    const prompt = `
    Tu es un assistant SAV serviable et chaleureux.
    Rédige une réponse courte à ${simplifiedData.first_name}.
    
    INFORMATIONS DU COLIS :
    - Numéro de suivi : ${simplifiedData.tracking_number}
    - Lien de suivi : ${simplifiedData.tracking_link}
    - Statut actuel : ${simplifiedData.current_status}
    - Historique récent :
    ${simplifiedData.history}

    CONSIGNES :
    - Commence par "Bonjour ${simplifiedData.first_name},"
    - Annonce clairement où en est le colis.
    - Donne le lien de suivi.
    - Sois rassurant et professionnel.
    - Signe "L'équipe SAV".
    `;

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
    });

    return response.choices[0].message.content;
}


// --- ROUTES ---

app.post("/sav/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return jsonError(res, 400, "missing image");
    
    // 1. Extraction & Classification
    const iaAnalysis = await extractAndClassify(req.file);
    
    // Si ce n'est pas une demande de suivi, on arrête là ou on fait une réponse générique
    if (!iaAnalysis.intent.needs_tracking) {
        return res.json({
            ok: true,
            type: "no_tracking_request",
            analysis: iaAnalysis,
            reply: "Il ne semble pas s'agir d'une demande de suivi."
        });
    }

    // 2. Résolution (Recherche des données)
    const resolution = await resolveTrackingLogic(iaAnalysis.identifiers);
    
    // 3. Simplification
    const simpleContext = simplifyContext(iaAnalysis, resolution);

    // 4. Rédaction
    const draft = await draftResponse(simpleContext);

    return res.json({ 
        ok: true, 
        type: "tracking_request",
        simple_data: simpleContext, // Les données épurées
        draft_reply: draft,         // La réponse rédigée
        debug: { analysis: iaAnalysis, logs: resolution.logs } // Pour le debug
    });
    
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "sav_analyze_failed", String(e?.message || e));
  }
});


// --- CLIENTS API (Woo/Sendcloud) ---

async function wooFetchOrdersBySearch(term) {
  const base = requireEnv("WC_BASE_URL").replace(/\/$/, "");
  const ck = requireEnv("WC_CONSUMER_KEY");
  const cs = requireEnv("WC_CONSUMER_SECRET");
  const url = new URL(`${base}/wp-json/wc/v3/orders`);
  url.searchParams.set("search", term);
  url.searchParams.set("per_page", "5");
  const r = await fetch(url.toString(), { headers: { Authorization: basicAuthHeader(ck, cs) } });
  if (!r.ok) return [];
  return await r.json();
}

async function wooFetchOrderById(id) {
    const base = requireEnv("WC_BASE_URL").replace(/\/$/, "");
    const ck = requireEnv("WC_CONSUMER_KEY");
    const cs = requireEnv("WC_CONSUMER_SECRET");
    const r = await fetch(`${base}/wp-json/wc/v3/orders/${id}`, { headers: { Authorization: basicAuthHeader(ck, cs) } });
    if (!r.ok) return null;
    return await r.json();
}

async function wooLookupBySearchTerm(term) {
  const orders = await wooFetchOrdersBySearch(term);
  if (!orders || !orders.length) return { order_number: null };
  const latest = orders[0];
  // On récupère le tracking des meta
  const meta = latest.meta_data || [];
  const keys = (process.env.TRACKING_META_KEYS || "").split(",").map(s=>s.trim());
  let tn = null;
  for(const k of keys) {
      const hit = meta.find(m => m.key === k && m.value);
      if(hit) tn = hit.value;
  }
  return { order_number: latest.id, tracking_number: tn };
}

async function sendcloudGet(path) {
  const pub = requireEnv("SENDCLOUD_PUBLIC_KEY");
  const sec = requireEnv("SENDCLOUD_SECRET_KEY");
  const r = await fetch(`https://panel.sendcloud.sc${path}`, { headers: { Authorization: basicAuthHeader(pub, sec) } });
  if (!r.ok) throw new Error(`Sendcloud error: ${r.status}`);
  return await r.json();
}

async function sendcloudFindParcelByOrderNumber(order_number) {
  const q = encodeURIComponent(String(order_number));
  return await sendcloudGet(`/api/v2/parcels?order_number=${q}`);
}

async function sendcloudTrackByTrackingNumber(tn) {
    const q = encodeURIComponent(String(tn));
    return await sendcloudGet(`/api/v2/tracking/${q}`);
}

function pickTrackingNumberFromParcelsResponse(payload) {
  const candidates = payload?.parcels ?? payload?.results ?? payload?.data ?? (payload?.parcel ? [payload.parcel] : []);
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;
  const first = list[0];
  return first?.tracking_number || first?.tracking?.tracking_number || null;
}

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
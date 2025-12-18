import express from "express";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

// On gère le raw text si besoin, mais ici on renvoie surtout du text/plain
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

// --- ÉTAPE 1 : EXTRACTION TECHNIQUE (Yeux bioniques pour les données) ---

async function extractIdentifiers(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Tu es un extracteur de données techniques."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extrais les identifiants techniques de cette image.",
                "JSON STRICT ATTENDU :",
                "{",
                '  "customer_first_name": string | null,',
                '  "identifiers": {',
                '     "email": null,',
                '     "phone": null,',
                '     "order_number": null,',
                '     "tracking_number": null',
                '  }',
                "}",
                "RÈGLES :",
                "- Phone : Cherche dans le HEADER (haut de l'image). Nettoie les espaces.",
                "- Prénom : Cherche dans le titre de la conversation.",
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
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("Invalid JSON from AI extraction");
    
    return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
}

// --- ÉTAPE 2 : RECHERCHE (Logique Woo/Sendcloud) ---

async function resolveTrackingLogic(identifiers) {
    const logs = [];
    const email = identifiers?.email ?? null;
    const phone = identifiers?.phone ?? null;
    const order_number_in = identifiers?.order_number ?? null;
    const tracking_in = identifiers?.tracking_number ?? null;

    // 1. Tracking direct
    if (tracking_in) {
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      return { logs, data: tracking, tracking_number: tracking_in, woo_order: null };
    }

    // 2. Numéro de commande
    if (order_number_in) {
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      if (tn) {
          const tracking = await sendcloudTrackByTrackingNumber(tn);
          return { logs, data: tracking, tracking_number: tn, woo_order: null };
      }
    }

    // 3. Email
    if (email) {
      const res = await tryResolveViaWooSearch(email, logs);
      if (res) return res;
    }

    // 4. Téléphone (Avec retry intelligent)
    if (phone) {
      let cleanPhone = phone.replace(/\D/g, ''); 
      let res = await tryResolveViaWooSearch(cleanPhone, logs);
      if (res) return res;

      if (cleanPhone.startsWith('33') && cleanPhone.length > 9) {
          let local = '0' + cleanPhone.substring(2);
          res = await tryResolveViaWooSearch(local, logs);
          if (res) return res;
      }
      if (cleanPhone.startsWith('0') && cleanPhone.length > 9) {
          let inter = '33' + cleanPhone.substring(1);
          res = await tryResolveViaWooSearch(inter, logs);
          if (res) return res;
      }
    }

    return { logs, data: null, tracking_number: null, woo_order: null };
}

async function tryResolveViaWooSearch(term, logs) {
    const woo = await wooLookupBySearchTerm(term);
    if (!woo.order_number) return null;

    const wooOrderFull = await wooFetchOrderById(woo.order_number); 

    let tn = woo.tracking_number;
    if (!tn) {
        const parcels = await sendcloudFindParcelByOrderNumber(woo.order_number);
        tn = pickTrackingNumberFromParcelsResponse(parcels);
    }

    if (tn) {
        const tracking = await sendcloudTrackByTrackingNumber(tn);
        return { logs, data: tracking, tracking_number: tn, woo_order: wooOrderFull };
    }
    
    return { logs, data: null, tracking_number: null, woo_order: wooOrderFull, status: "processing_no_tracking" };
}

// --- ÉTAPE 3 : SIMPLIFICATION ---

function simplifyContext(iaResult, resolutionResult) {
    let firstName = "Client";
    if (resolutionResult?.woo_order?.billing?.first_name) {
        firstName = resolutionResult.woo_order.billing.first_name;
    } else if (iaResult?.customer_first_name) {
        firstName = iaResult.customer_first_name;
    }

    const trackingData = resolutionResult?.data;
    const trackingNumber = resolutionResult?.tracking_number;
    
    const trackingLink = trackingData?.carrier_tracking_url 
                      || trackingData?.sendcloud_tracking_url 
                      || (trackingNumber ? `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}` : null);

    let history = [];
    let lastHistoryStatus = null;

    if (trackingData?.statuses && Array.isArray(trackingData.statuses) && trackingData.statuses.length > 0) {
        const lastEntry = trackingData.statuses[trackingData.statuses.length - 1];
        lastHistoryStatus = lastEntry.carrier_message || lastEntry.status;
        history = trackingData.statuses.slice(-3).map(s => ` - ${s.carrier_message || s.status}`).reverse();
    }

    const currentStatus = trackingData?.status?.message 
                       || trackingData?.carrier_status 
                       || lastHistoryStatus 
                       || "En cours de traitement";

    return {
        first_name: firstName,
        tracking_number: trackingNumber,
        tracking_link: trackingLink,
        current_status: currentStatus,
        history: history.join("\n"),
        is_found: !!trackingNumber
    };
}

// --- ÉTAPE 4 : ROBIN 🌞 (Rédaction avec Vision) ---

async function draftResponseWithVision(data, file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    // Prompt système "Robin"
    const systemPrompt = `
    Tu es Robin du service après vente d'une petite marque de bijoux qui s'appelle Solstice, spécialisée dans les piercings. Tu es également experte en piercing.
    Ton objectif est de répondre au client en t'adaptant parfaitement au contexte visuel et technique.

    TON STYLE :
    - Vouvoiement obligatoire.
    - "Bonjour [Prénom],"
    - 1 emoji par message MAX (sauf la signature).
    - Signature obligatoire : "Robin 🌞"
    - Interdiction stricte d'utiliser le caractère "—" (tiret cadratin).
    - Ton : Courtois, poli, compréhensif, solaire, mais direct.
    
    ADAPTATION AU CONTEXTE VISUEL (Capture d'écran) :
    - Analyse l'image pour déterminer la plateforme (WhatsApp, SMS, Mail, Instagram).
    - Si c'est WhatsApp/SMS/Insta : Fais une réponse courte, fluide, style messagerie instantanée. Pas de "Cordialement", va droit au but.
    - Si c'est un Mail : Garde une structure plus formelle (intro, corps, formule de politesse).
    - Analyse le ton du client dans la capture (Est-il inquiet ? En colère ? Juste curieux ?). Adapte ton empathie (rassure s'il est inquiet).
    
    INFORMATIONS TECHNIQUES À DONNER :
    - Statut du colis : ${data.current_status}
    - Lien de suivi : ${data.tracking_link}
    `;

    // Prompt utilisateur (Cas FOUND ou NOT FOUND)
    let userContentText = "";

    if (data.is_found) {
        userContentText = `
        Le client s'appelle ${data.first_name}.
        J'ai trouvé sa commande !
        Confirme-lui que c'est tout bon. Donne-lui le statut (${data.current_status}) et le lien de suivi (${data.tracking_link}).
        Si le statut indique que c'est livré mais qu'il demande où c'est, dis-lui de vérifier sa boîte aux lettres ou ses voisins.
        `;
    } else {
        userContentText = `
        Le client s'appelle ${data.first_name}.
        Malheureusement, je n'ai pas réussi à retrouver sa commande avec les infos de l'image.
        Excuse-toi et demande-lui poliment son numéro de commande ou l'email utilisé.
        `;
    }

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini", // Utilisation de GPT-4o Vision implicite via chat.completions
        messages: [
            { role: "system", content: systemPrompt },
            { 
                role: "user", 
                content: [
                    { type: "text", text: userContentText },
                    { type: "image_url", image_url: { url: dataUrl } }
                ] 
            }
        ]
    });

    return response.choices[0].message.content;
}


// --- ROUTE UNIQUE ---

app.post("/sav/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Erreur: Image manquante");
    
    // 1. Extraction (Identification seulement)
    const extracted = await extractIdentifiers(req.file);
    
    // 2. Résolution (Woo/Sendcloud)
    const resolution = await resolveTrackingLogic(extracted.identifiers);
    
    // 3. Simplification
    const simpleContext = simplifyContext(extracted, resolution);

    // 4. Rédaction (Robin avec Vision)
    // On repasse le fichier image pour que Robin "voie" le contexte
    const finalText = await draftResponseWithVision(simpleContext, req.file);

    // RETOUR TEXTE PUR (MIME Type: text/plain)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(finalText);
    
  } catch (e) {
    console.error(e);
    // Retour texte pur même en cas d'erreur
    res.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send("Bonjour,\n\nUne petite erreur technique m'empêche de récupérer votre suivi pour l'instant. Pourriez-vous me redonner votre numéro de commande ?\n\nMerci,\nRobin 🌞");
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
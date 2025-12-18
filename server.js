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

// ==========================================
// OUTILS COMMUNS (Extraction & Clients)
// ==========================================

async function extractIdentifiers(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5-nano", // Extraction rapide
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Tu es un extracteur de données techniques." },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extrais les identifiants techniques.",
                "JSON ATTENDU :",
                "{",
                '  "customer_first_name": string | null,',
                '  "identifiers": { "email": null, "phone": null, "order_number": null, "tracking_number": null }',
                "}",
                "RÈGLES :",
                "- Tracking Number : Cherche le code-barres ou le numéro de suivi sur l'étiquette (ex: 1Z..., L..., 87...).",
                "- Phone : Prends TOUS les chiffres.",
                "- Prénom : Cherche sur l'étiquette d'expédition si visible."
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
    return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
}

// --- FONCTION SPÉCIALE : EXTRACTION TRACKING UNIQUEMENT ---
async function extractTrackingSpecific(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5-nano", // Rapide et efficace pour l'OCR
      response_format: { type: "json_object" },
      messages: [
        { 
          role: "system", 
          content: "Tu es un scanner optique spécialisé dans la lecture d'étiquettes d'expédition." 
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "TA MISSION : Lire le Numéro de Suivi (Tracking Number) et le Prénom sur cette photo.",
                "",
                "JSON STRICT ATTENDU :",
                "{",
                '  "tracking_number": string | null, // Ex: "LA123456789FR", "1Z...", "87..."',
                '  "first_name": string | null // Le prénom du destinataire',
                "}",
                "",
                "CONSIGNES :",
                "1. Cherche le code-barres principal ou la mention 'N° de suivi' / 'Tracking'.",
                "2. Ignore les numéros de téléphone (+33...).",
                "3. Si le numéro contient des espaces (ex: 'LA 123 456 FR'), supprime-les dans ta réponse.",
                "4. Sois précis."
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
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("Erreur lecture JSON IA");
    
    return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
}

// ==========================================
// ROUTE 1 : SAV TRACKING FRANCE (Automatique + Check Pays)
// ==========================================

async function resolveTrackingLogic(identifiers) {
    const logs = [];
    const email = identifiers?.email ?? null;
    const phone = identifiers?.phone ?? null;
    const order_number_in = identifiers?.order_number ?? null;
    const tracking_in = identifiers?.tracking_number ?? null;

    if (order_number_in) {
      const wooOrder = await wooFetchOrderById(order_number_in);
      if (checkInternational(wooOrder)) return { isInternational: true, logs };
      
      const parcels = await sendcloudFindParcelByOrderNumber(order_number_in);
      const tn = pickTrackingNumberFromParcelsResponse(parcels);
      if (tn) {
          const tracking = await sendcloudTrackByTrackingNumber(tn);
          return { logs, data: tracking, tracking_number: tn, woo_order: wooOrder };
      }
    }

    if (email) {
      const res = await tryResolveViaWooSearch(email, logs);
      if (res) return res;
    }

    if (phone) {
      let rawDigits = phone.replace(/\D/g, ''); 
      let candidates = new Set();
      candidates.add(rawDigits);
      candidates.add('+' + rawDigits);
      candidates.add('00' + rawDigits);
      if (rawDigits.startsWith('33') && rawDigits.length > 9) candidates.add('0' + rawDigits.substring(2));
      if (rawDigits.startsWith('0') && rawDigits.length === 10) {
          candidates.add('33' + rawDigits.substring(1));
          candidates.add('+33' + rawDigits.substring(1));
      }
      if (rawDigits.startsWith('32') && rawDigits.length > 8) candidates.add('0' + rawDigits.substring(2));
      if (rawDigits.startsWith('41') && rawDigits.length > 8) candidates.add('0' + rawDigits.substring(2));

      const searchPromises = Array.from(candidates).map(c => tryResolveViaWooSearch(c, logs));
      const results = await Promise.all(searchPromises);
      const validResult = results.find(r => r !== null);
      if (validResult) return validResult;
    }

    if (tracking_in) {
      const tracking = await sendcloudTrackByTrackingNumber(tracking_in);
      if (tracking.destination && tracking.destination !== 'FR' && tracking.destination !== 'FRANCE') {
           return { isInternational: true, logs };
      }
      return { logs, data: tracking, tracking_number: tracking_in, woo_order: null };
    }

    return { logs, data: null, tracking_number: null, woo_order: null };
}

function checkInternational(wooOrder) {
    if (!wooOrder) return false;
    const country = wooOrder.shipping?.country || wooOrder.billing?.country;
    return (country && country !== 'FR');
}

async function tryResolveViaWooSearch(term, logs) {
    const woo = await wooLookupBySearchTerm(term);
    if (!woo.order_number) return null;
    if (woo.country && woo.country !== 'FR') return { isInternational: true, logs };

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

function simplifyContext(iaResult, resolutionResult) {
    let firstName = "Client";
    if (resolutionResult?.woo_order?.billing?.first_name) {
        firstName = resolutionResult.woo_order.billing.first_name;
    } else if (iaResult?.customer_first_name) {
        firstName = iaResult.customer_first_name;
    }
    const trackingData = resolutionResult?.data;
    const trackingNumber = resolutionResult?.tracking_number;
    const trackingLink = trackingData?.carrier_tracking_url || trackingData?.sendcloud_tracking_url || (trackingNumber ? `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}` : null);
    
    let history = [];
    let lastHistoryStatus = null;
    if (trackingData?.statuses && Array.isArray(trackingData.statuses) && trackingData.statuses.length > 0) {
        const lastEntry = trackingData.statuses[trackingData.statuses.length - 1];
        lastHistoryStatus = lastEntry.carrier_message || lastEntry.status;
        history = trackingData.statuses.slice(-3).map(s => ` - ${s.carrier_message || s.status}`).reverse();
    }
    const currentStatus = trackingData?.status?.message || trackingData?.carrier_status || lastHistoryStatus || "En cours de traitement";
    return { first_name: firstName, tracking_number: trackingNumber, tracking_link: trackingLink, current_status: currentStatus, history: history.join("\n"), is_found: !!trackingNumber };
}

async function draftResponseWithVision(data, file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;
    const systemPrompt = `
    Tu es Robin du service après vente de Solstice Bijoux.
    TON STYLE : Vouvoiement. "Bonjour [Prénom],". 1 emoji max. Signature : "Robin 🌞". Pas de tiret "—". Ton courtois, poli, compréhensif.
    ADAPTATION : Analyse la plateforme (WhatsApp/Mail) pour la structure.
    INFO : Statut: ${data.current_status}, Lien: ${data.tracking_link}.
    `;
    let userContentText = data.is_found 
        ? `Le client s'appelle ${data.first_name}. Commande trouvée ! Donne le statut et le lien.` 
        : `Le client s'appelle ${data.first_name}. Commande non trouvée. Demande poliment le numéro ou l'email.`;

    const response = await openai.chat.completions.create({
        model: "gpt-5", // Rédaction puissante
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: [{ type: "text", text: userContentText }, { type: "image_url", image_url: { url: dataUrl } }] }
        ]
    });
    return response.choices[0].message.content;
}

app.post("/sav/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Erreur: Image manquante");
    
    const extracted = await extractIdentifiers(req.file);
    const resolution = await resolveTrackingLogic(extracted.identifiers);

    if (resolution.isInternational) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send("international");
    }

    const simpleContext = simplifyContext(extracted, resolution);
    const finalText = await draftResponseWithVision(simpleContext, req.file);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(finalText);
  } catch (e) {
    console.error(e);
    res.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send("Bonjour,\n\nUne erreur technique m'empêche de répondre. Pourriez-vous reformuler ?\n\nMerci,\nRobin 🌞");
  }
});


// ==========================================
// ROUTE 3 : SAV INTERNATIONAL (DEBUG MODE)
// ==========================================

app.post("/sav/international", upload.single("image"), async (req, res) => {
    console.log("🔵 --- DÉBUT REQUÊTE INTERNATIONAL ---");
    
    try {
        // CHECK 1 : Image
        if (!req.file) {
            console.error("❌ ERREUR: Aucune image reçue dans la requête.");
            return res.status(400).send("Erreur: Image manquante");
        }
        console.log(`✅ Image reçue. Taille: ${req.file.size} bytes. Mimetype: ${req.file.mimetype}`);

        // CHECK 2 : Clé API 17TRACK
        const track17Key = process.env.TRACK17_KEY;
        if (!track17Key) {
            console.error("❌ ERREUR CRITIQUE: La variable TRACK17_KEY est introuvable.");
            throw new Error("Configuration manquante : TRACK17_KEY");
        }
        console.log("✅ Clé API 17TRACK détectée.");

        // ÉTAPE 1 : Extraction OpenAI
        console.log("📍 ÉTAPE 1 : Envoi image à OpenAI pour extraction...");
        let extracted;
        try {
            extracted = await extractIdentifiers(req.file);
            console.log("📄 Résultat extraction brut :", JSON.stringify(extracted));
        } catch (openaiError) {
            console.error("❌ ERREUR OPENAI (Extraction):", openaiError);
            // Souvent c'est le nom du modèle (gpt-5 n'existe pas encore publiquement)
            return res.status(500).send(`Erreur OpenAI Extraction: ${openaiError.message}`);
        }

        let trackingNumber = extracted.identifiers?.tracking_number;
        
        if (!trackingNumber) {
             console.warn("⚠️ ALERTE: Aucun numéro de suivi trouvé par l'IA.");
             return res.send("Bonjour,\n\nJe n'ai pas réussi à lire le numéro de suivi sur la photo. Pourriez-vous me l'écrire ?\n\nRobin 🌞");
        }

        const cleanTracking = trackingNumber.replace(/\s+/g, '').toUpperCase();
        console.log(`✅ Numéro extrait et nettoyé : "${cleanTracking}"`);

        // ÉTAPE 2 : Appel 17TRACK
        console.log("📍 ÉTAPE 2 : Appel API 17TRACK (Register)...");
        
        let packageInfo = null;
        
        const registerResponse = await fetch("https://api.17track.net/track/v2.2/register", {
            method: "POST",
            headers: { "17token": track17Key, "Content-Type": "application/json" },
            body: JSON.stringify([{ number: cleanTracking }])
        });

        const trackData = await registerResponse.json();
        console.log("📄 Réponse 17TRACK (Register) :", JSON.stringify(trackData));

        if (trackData?.data?.accepted?.length > 0) {
            console.log("✅ Nouveau colis enregistré.");
            packageInfo = trackData.data.accepted[0];
        } 
        else if (trackData?.data?.rejected?.length > 0) {
            const error = trackData.data.rejected[0].error;
            console.log(`⚠️ Rejeté par Register. Code: ${error.code} - Message: ${error.message}`);

            if (error.code === -18019901) {
                console.log("📍 Le numéro existe déjà. Tentative GetTrackInfo...");
                
                const infoResponse = await fetch("https://api.17track.net/track/v2.2/gettrackinfo", {
                    method: "POST",
                    headers: { "17token": track17Key, "Content-Type": "application/json" },
                    body: JSON.stringify([{ number: cleanTracking }])
                });
                const infoData = await infoResponse.json();
                console.log("📄 Réponse 17TRACK (GetInfo) :", JSON.stringify(infoData));
                
                if (infoData?.data?.accepted?.length > 0) {
                    packageInfo = infoData.data.accepted[0];
                    console.log("✅ Infos récupérées.");
                }
            }
        }

        // Préparation données pour Robin
        let statusInfo = "En attente d'informations";
        let historyText = "Pas d'historique disponible.";
        let destination = "International";

        if (packageInfo && packageInfo.track) {
            const trackInfo = packageInfo.track;
            const latestEvent = trackInfo.z1?.[0] || trackInfo.z0?.[0]; 
            statusInfo = latestEvent ? latestEvent.z : "En transit";
            destination = packageInfo.recipientCountry || "International";

            const allEvents = [...(trackInfo.z0 || []), ...(trackInfo.z1 || [])]
                .sort((a, b) => new Date(b.a) - new Date(a.a)) 
                .slice(0, 5);
            
            if (allEvents.length > 0) {
                historyText = allEvents.map(e => ` - ${e.a} : ${e.z}`).join("\n");
            }
        } else {
            console.warn("⚠️ Aucune info de tracking trouvée, Robin va devoir improviser.");
        }

        // ÉTAPE 3 : Rédaction Robin
        console.log("📍 ÉTAPE 3 : Génération de la réponse avec Robin...");
        const b64Context = req.file.buffer.toString("base64");
        const systemPrompt = `
        Tu es Robin du service après vente de Solstice Bijoux.
        CONTEXTE : Suivi International (17TRACK).
        Numéro : ${cleanTracking}
        Destination : ${destination}
        DONNÉES TECHNIQUES :
        - Statut Actuel : "${statusInfo}"
        - Historique :
        ${historyText}
        TA MISSION :
        - Rédige une réponse rassurante.
        - Donne le lien : https://t.17track.net/fr#nums=${cleanTracking}
        STYLE : "Bonjour [Prénom],", Vouvoiement, 1 emoji max, Signé "Robin 🌞".
        `;

        try {
            const response = await openai.chat.completions.create({
                model: "gpt-5", // ATTENTION : Si gpt-5 n'existe pas, mettre "gpt-4o"
                messages: [
                    { role: "system", content: systemPrompt },
                    { 
                        role: "user", 
                        content: [
                            { type: "text", text: "Photo du colis (pour le prénom)." },
                            { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${b64Context}` } }
                        ] 
                    }
                ]
            });
            console.log("✅ Réponse générée.");
            
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(response.choices[0].message.content);

        } catch (gptError) {
            console.error("❌ ERREUR OPENAI (Rédaction):", gptError);
            return res.status(500).send(`Erreur OpenAI Rédaction: ${gptError.message}`);
        }

    } catch (e) {
        console.error("💀 ERREUR GÉNÉRALE SERVEUR :", e);
        res.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(`Erreur technique interne: ${e.message}`);
    }
});

// ==========================================
// ROUTE 2 : SAV GÉNÉRAL (Avec instructions)
// ==========================================

app.post("/sav/general", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send("Erreur: Image manquante");
        const instructions = req.body.instructions || "Analyse ce message et réponds de manière pertinente.";
        const b64 = req.file.buffer.toString("base64");
        const dataUrl = `data:${req.file.mimetype};base64,${b64}`;

        const systemPrompt = `
        Tu es Robin du service après vente de Solstice Bijoux.
        TON STYLE : Vouvoiement. "Bonjour [Prénom],". 1 emoji max. Signature : "Robin 🌞". Pas de tiret "—".
        OBJECTIF: Répondre selon les instructions : "${instructions}"
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-5",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }
            ]
        });

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(response.choices[0].message.content);
    } catch (e) {
        console.error(e);
        res.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send("Erreur lors de la génération de la réponse.\n\nRobin 🌞");
    }
});

// ==========================================
// CLIENTS API
// ==========================================

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
  const country = latest.shipping?.country || latest.billing?.country || "FR";
  return { order_number: latest.id, tracking_number: tn, country: country };
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
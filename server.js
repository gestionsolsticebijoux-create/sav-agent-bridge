import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { Agent, Runner, fileSearchTool } from "@openai/agents";
import fs from "fs";
import path from "path";
// Stockage temporaire des réponses (en mémoire RAM)
// Structure : { "ticket_ID": { status: "pending" | "done", result: "..." } }
const tasks = {};
// ==========================================
// 1. CONFIGURATION
// ==========================================

if (!process.env.OPENAI_API_KEY) {
    console.error("❌ ERREUR FATALE : OPENAI_API_KEY manquante.");
    process.exit(1);
}
if (!process.env.TRACK17_KEY) {
    console.error("⚠️ ATTENTION : TRACK17_KEY manquante.");
}

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 2. HELPERS
// ==========================================

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function basicAuthHeader(user, pass) {
  const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function parseTrackInfo(info) {
    const dest = info.recipientCountry || "International";
    const track = info.track;
    
    if (!track) {
        return { 
            dest, 
            status: "En attente de mise à jour transporteur", 
            history: "Information en cours de récupération..." 
        };
    }

    let status = "En transit";
    let history = "";

    const latest = track.z1?.[0] || track.z0?.[0];
    if (latest && latest.z) status = latest.z;

    const allEvents = [...(track.z0 || []), ...(track.z1 || [])]
        .sort((a, b) => new Date(b.a) - new Date(a.a))
        .slice(0, 3);
    
    if (allEvents.length > 0) {
        history = allEvents.map(e => ` - ${e.a} : ${e.z}`).join("\n");
    }
    return { dest, status, history };
}

// ==========================================
// 3. EXTRACTION (Modèle: gpt-5-nano)
// ==========================================

async function extractIdentifiers(file) {
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${file.mimetype};base64,${b64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5-nano", 
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
                "RÈGLES STRICTES POUR LE TRACKING NUMBER :",
                "1. Cherche un code alphanumérique de 13 caractères.",
                "2. FORMAT TYPE : 2 lettres + 9 chiffres + 2 lettres (Exemple: LE123456789FR).",
                "3. IMPORTANT : Tu DOIS inclure les lettres du début (ex: LE, LP, RK) et de la fin (ex: FR).",
                "4. Si tu vois 'LE 14...', écris 'LE14...'.",
                "- Phone : Prends TOUS les chiffres.",
                "- Prénom : Cherche sur l'étiquette d'expédition."
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
        model: "gpt-5",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: [{ type: "text", text: userContentText }, { type: "image_url", image_url: { url: dataUrl } }] }
        ]
    });
    return response.choices[0].message.content;
}

// ==========================================
// ROUTE 1 : SAV FRANCE (Legacy)
// ==========================================

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
// ROUTE 2-A : EXTRACTION TEXTUELLE (/sav/extract)
// (Prend du TEXTE brut -> Renvoie JUSTE le numéro nettoyé)
// ==========================================

app.post("/sav/extract", upload.none(), async (req, res) => {
    console.log("\n🔵 [ROUTE /sav/extract] Début analyse texte...");
    
    try {
        // On récupère le texte envoyé par l'iPhone (OCR)
        const rawText = req.body.raw_text;

        if (!rawText) {
            console.error("❌ ERREUR: Aucune donnée texte reçue (champ 'raw_text' vide).");
            return res.status(400).send("Erreur: Texte manquant");
        }

        console.log(`📝 Texte reçu (${rawText.length} caractères) : "${rawText.substring(0, 50).replace(/\n/g, ' ')}..."`);

        // UTILISATION DE GPT-5-NANO (Suffisant pour analyser du texte)
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "Tu es un expert en correction de données logistiques." },
                { role: "user", content: 
                    `Voici un texte brut extrait d'une étiquette de colis (OCR).
                    
                    TA MISSION :
                    Trouve et isole le Numéro de Suivi (Tracking Number).
                    
                    RÈGLES DE DÉTECTION :
                    1. Format standard : 2 Lettres + 9 Chiffres + 2 Lettres (Ex: LE123456789FR).
                    2. Variantes possibles : 1Z... (UPS), 87... (Colissimo).
                    3. CORRECTION D'ERREURS : 
                       - L'OCR met souvent des espaces (ex: "LE 14 55" -> "LE1455"). Supprime-les.
                       - Il peut confondre le chiffre '0' et la lettre 'O'. Corrige selon le format standard.
                    
                    TEXTE À ANALYSER :
                    """${rawText}"""
                    
                    JSON ATTENDU : { "tracking_number": "LE..." }`
                }
            ]
        });

        const content = JSON.parse(response.choices[0].message.content);
        const trackingNumber = content.tracking_number;

        if (!trackingNumber) {
            console.warn("⚠️ Aucun numéro trouvé dans le texte.");
            return res.status(404).send("NON_TROUVE");
        }

        // Nettoyage final de sécurité
        const cleanTracking = trackingNumber.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        console.log(`✅ Numéro extrait et nettoyé : ${cleanTracking}`);
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(cleanTracking);

    } catch (e) {
        console.error("❌ ERREUR Extraction Texte:", e);
        res.status(500).send(`Erreur serveur: ${e.message}`);
    }
});

// ==========================================
// ROUTE 2-B : RÉPONSE SAV INTERNATIONAL (/sav/respond)
// ==========================================

app.post("/sav/respond", upload.single("image"), async (req, res) => {
    console.log("\n🔵 [ROUTE /sav/respond] Début analyse 17TRACK...");
    
    try {
        const trackingNumber = req.body.tracking_number;
        
        if (!trackingNumber) {
            console.error("❌ Erreur : Le champ 'tracking_number' est vide.");
            return res.status(400).send("Erreur: tracking_number manquant.");
        }

        console.log(`1. Tracking reçu : ${trackingNumber}`);
        console.log("2. Appel API 17TRACK...");

        const trackResponse = await fetch("https://api.17track.net/track/v2.2/register", {
            method: "POST",
            headers: {
                "17token": process.env.TRACK17_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify([{ number: trackingNumber }])
        });

        const trackData = await trackResponse.json();
        
        let statusInfo = "Inconnu / En attente";
        let historyText = "Pas d'historique disponible.";
        let destination = "International";

        if (trackData?.data?.accepted?.length > 0) {
            const result = parseTrackInfo(trackData.data.accepted[0]);
            destination = result.dest;
            statusInfo = result.status;
            historyText = result.history;
        } 
        else if (trackData?.data?.rejected?.length > 0) {
            const error = trackData.data.rejected[0].error;
            if (error.code === -18019901) {
                console.log("📍 Colis déjà suivi, appel endpoint 'gettrackinfo'...");
                const infoResponse = await fetch("https://api.17track.net/track/v2.2/gettrackinfo", {
                    method: "POST",
                    headers: { "17token": process.env.TRACK17_KEY, "Content-Type": "application/json" },
                    body: JSON.stringify([{ number: trackingNumber }])
                });
                const infoData = await infoResponse.json();
                if (infoData?.data?.accepted?.length > 0) {
                    const result = parseTrackInfo(infoData.data.accepted[0]);
                    destination = result.dest;
                    statusInfo = result.status;
                    historyText = result.history;
                }
            } else {
                statusInfo = "Numéro non reconnu ou incorrect.";
            }
        }
        
        console.log(`3. Infos récupérées : Dest=${destination}, Status=${statusInfo}`);

        console.log("4. Rédaction par Robin (GPT-5)...");
        
        let messagesPayload = [
            { role: "system", content: `
            Tu es Robin, chargé du service client de Solstice Bijoux (marque de piercing).
            Ton super-pouvoir est l’empathie et la chaleur humaine. Tu t’exprimes comme une personne bienveillante et impliquée, jamais comme un robot logistique.

            Objectif de la tâche
            Répondre à la cliente pour lui expliquer où se trouve son colis, en t’appuyant sur tous les éléments disponibles (y compris une image/capture d’écran fournie en pièce jointe), afin de la rassurer, de clarifier la situation, et de désamorcer l’inquiétude.

            ⚠️ L’image est uniquement un support d’analyse interne :

            Tu ne dois jamais mentionner la capture d’écran, l’image, ou le fait que tu l’as consultée.

            Tu dois simplement intégrer ses informations de façon naturelle dans ta réponse.

            Contexte du colis

            Numéro de suivi : ${trackingNumber}

            Destination : ${destination}

            Statut technique : ${statusInfo}

            Historique récent : ${historyText}

            Mission émotionnelle et logique

            Analyse la situation réelle du colis

            Croise le statut technique, l’historique et les informations implicites issues de l’image.

            Reformule la situation avec des mots simples et compréhensibles pour une cliente non experte.

            Adopte la posture émotionnelle adaptée

            Colis en transit (normal) : rassure, confirme que l’acheminement suit son cours.

            Colis en douane ou arrivé dans le pays : explique calmement que c’est une étape classique, parfois un peu lente, mais normale. Pédagogie et apaisement.

            Colis livré ou disponible : partage l’enthousiasme et la bonne nouvelle.

            Gestion du retard et des responsabilités

            Si un retard est visible ou probable, présente des excuses sincères pour l’attente.

            Explique avec douceur que les délais dépendent du transporteur ou des douanes.

            Précise que, de ton côté, aucune action directe n’est possible à ce stade, tout en restant solidaire de la cliente.

            Règles de forme (non négociables)

            Ton : solaire, empathique, rassurant, professionnel, humain

            Vouvoiement obligatoire

            Début : Bonjour [Prénom si disponible],

            Structure :

            WhatsApp : concis et fluide

            Email : légèrement plus structuré

            Emoji : 1 seul emoji maximum dans le corps du texte (hors signature)

            Interdit :

            ne jamais utiliser le tiret cadratin —

            ne jamais mentionner l’image, la capture d’écran ou l’analyse visuelle

            ne jamais parler comme un système automatisé

            Action obligatoire
            Inclure systématiquement ce lien de suivi à la fin du message :
            https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}

            Signature obligatoire
            Robin 🌞` 
            }
        ];

        if (req.file) {
            const b64 = req.file.buffer.toString("base64");
            messagesPayload.push({
                role: "user",
                content: [
                    { type: "text", text: "Voici la conversation avec le client. Adapte ton ton." },
                    { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${b64}` } }
                ]
            });
        } else {
            messagesPayload.push({ role: "user", content: "Rédige la réponse." });
        }

        const gptResponse = await openai.chat.completions.create({
            model: "gpt-5",
            messages: messagesPayload
        });

        console.log("✅ Réponse générée.");
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(gptResponse.choices[0].message.content);

    } catch (e) {
        console.error("❌ ERREUR REPONSE:", e);
        res.status(500).send(`Erreur serveur: ${e.message}`);
    }
});

// ==========================================
// ROUTE 4 : SAV GÉNÉRAL (/sav/general)
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
// ROUTE 5 : SOURCES TOP 10 (Mode Texte Brut)
// ==========================================
// ==========================================

app.post("/sources/top10", upload.none(), async (req, res) => {
    console.log("\n🔵 [ROUTE /sources/top10] Demande (Format Texte)...");

    try {
        const userText = req.body.text;
        if (!userText) return res.status(400).send("Erreur: Texte manquant");

        const assistantId = process.env.SOURCES_ASSISTANT_ID;
        if (!assistantId) return res.status(500).send("Erreur: Config ID manquante");

        const thread = await openai.beta.threads.create();
        await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: userText
        });

        const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
            assistant_id: assistantId,
        });

        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(thread.id);
            const lastMessage = messages.data.find(m => m.role === 'assistant');
            let responseText = lastMessage?.content?.[0]?.text?.value || "Pas de réponse.";

            // Nettoyage des annotations de source [4:0†source] pour que ce soit propre
            responseText = responseText.replace(/【.*?】/g, '');

            console.log("✅ Réponse texte envoyée.");
            
            // ICI : On force le mode TEXTE BRUT (pas de JSON)
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(responseText);

        } else {
            return res.status(500).send(`Erreur IA : ${run.status}`);
        }

    } catch (e) {
        console.error(e);
        return res.status(500).send(`Erreur Serveur : ${e.message}`);
    }
});

// ==========================================
// ROUTE 6-A : DÉMARRAGE TÂCHE (ASYNC)
// ==========================================
app.post("/chat/start", upload.single("image"), async (req, res) => {
    // 1. Générer un ID unique pour ce ticket
    const ticketId = "ticket_" + Date.now();
    console.log(`\n🎫 Nouveau ticket créé : ${ticketId}`);

    // 2. Initialiser le statut
    tasks[ticketId] = { status: "pending", result: null };

    // 3. Répondre TOUT DE SUITE à l'iPhone pour ne pas timeout
    res.json({ ticket_id: ticketId, status: "pending", message: "Traitement démarré..." });

    // 4. Lancer le travail LOURD en arrière-plan (sans bloquer la réponse)
    // (On ne met pas 'await' ici pour ne pas bloquer)
    processGPTRequest(ticketId, req.body, req.file).catch(err => {
        console.error(`❌ Erreur Background ${ticketId}:`, err);
        tasks[ticketId] = { status: "error", result: "Erreur interne." };
    });
});

// La fonction lourde qui parle à OpenAI (ex-contenu de ta route)
async function processGPTRequest(ticketId, body, file) {
    const userMessage = body.message || body.prompt;
    const isNewThread = body.new_thread === "true" || body.new_thread === true;
    const HISTORY_FILE = path.join(process.cwd(), "history.json");
    const PROMPT_ID = "pmpt_6901002708c0819682d17ea7dddecc5d09ec040d95dda014";

    // ... (Logique de chargement historique identique à avant) ...
    let conversation = [];
    if (isNewThread && fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
    else if (fs.existsSync(HISTORY_FILE)) {
        try { conversation = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")); } catch(e){}
    }
    
    // Ajout message user
    const currentUserMsg = { role: "user", content: userMessage };
    conversation.push(currentUserMsg);

    // Construction Inputs
    const inputsArray = conversation.map(msg => {
        const contentBlock = [];
        if (msg.content) {
            contentBlock.push({ 
                type: (msg.role === "assistant" ? "output_text" : "input_text"), 
                text: msg.content 
            });
        }
        if (msg === currentUserMsg && file) {
             const b64 = file.buffer.toString("base64");
             contentBlock.push({ type: "image_url", image_url: { url: `data:${file.mimetype};base64,${b64}` } });
        }
        return { role: msg.role, content: contentBlock };
    });

    console.log(`🤖 [${ticketId}] Envoi à OpenAI...`);
    
    try {
        const response = await openai.responses.create({
            model: "gpt-5.2",
            prompt: { "id": PROMPT_ID },
            input: inputsArray,
            store: true
        });

        // Extraction réponse
        let replyText = "Pas de réponse.";
        if (response.output_text) replyText = response.output_text;
        else if (response.content) {
            const t = response.content.find(c => c.type === 'output_text' || c.type === 'text');
            if (t) replyText = t.text || t.value;
        } else if (response.choices) replyText = response.choices[0].message.content;

        // Sauvegarde historique + Mise à jour du Ticket
        conversation.push({ role: "assistant", content: replyText });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversation, null, 2));
        
        console.log(`✅ [${ticketId}] Terminé !`);
        tasks[ticketId] = { status: "done", result: replyText };

    } catch (e) {
        console.error(`❌ [${ticketId}] Erreur OpenAI:`, e);
        tasks[ticketId] = { status: "error", result: e.message };
    }
}

// ==========================================
// ROUTE 6-B : VÉRIFICATION STATUT (POLLING)
// ==========================================
app.post("/chat/check", async (req, res) => {
    const ticketId = req.body.ticket_id;
    const task = tasks[ticketId];

    if (!task) {
        return res.json({ status: "error", message: "Ticket introuvable" });
    }

    if (task.status === "done") {
        // C'est fini ! On envoie la réponse et on nettoie la mémoire
        res.json({ status: "done", reply: task.result });
        delete tasks[ticketId]; // Ménage
    } else if (task.status === "error") {
        res.json({ status: "error", message: task.result });
        delete tasks[ticketId];
    } else {
        // Encore en cours
        res.json({ status: "pending" });
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
const server = app.listen(port, () => console.log(`Listening on ${port}`));

// 🛑 ANTI-TIMEOUT
server.keepAliveTimeout = 300 * 1000; 
server.headersTimeout = 305 * 1000;
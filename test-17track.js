// 1. Colle ta CLÉ API ici (celle qui commence par une longue suite de chiffres/lettres)
const API_KEY = "1231D926B5CFB79297BB3D5059FC9FAF";

// 2. Colle le NUMÉRO DE SUIVI que tu veux tester ici
// (Essaie d'abord avec un vieux colis qui a bien été livré pour être sûr)
const TRACKING_NUMBER = "LE149936917FR";

async function test17TrackRobust() {
    console.log(`🚀 DÉBUT DU TEST pour : ${TRACKING_NUMBER}`);
    console.log("------------------------------------------------");

    try {
        // --- ÉTAPE 1 : TENTATIVE D'ENREGISTREMENT (REGISTER) ---
        console.log("👉 Étape 1 : Tentative d'enregistrement (/register)...");
        
        let response = await fetch("https://api.17track.net/track/v2.2/register", {
            method: "POST",
            headers: { "17token": API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify([{ number: TRACKING_NUMBER }])
        });

        let data = await response.json();
        let finalPackage = null;

        // CAS A : NOUVEAU NUMÉRO (Succès immédiat)
        if (data.data && data.data.accepted.length > 0) {
            console.log("✅ SUCCÈS : Le numéro est nouveau et a été enregistré.");
            finalPackage = data.data.accepted[0];
        } 
        
        // CAS B : DÉJÀ ENREGISTRÉ (Erreur -18019901)
        else if (data.data && data.data.rejected.length > 0) {
            const error = data.data.rejected[0].error;
            console.log(`⚠️ REJETÉ : 17TRACK a répondu : ${error.message} (Code: ${error.code})`);

            if (error.code === -18019901) {
                console.log("\n🔄 RÉACTION : Le numéro existe déjà. On lance la récupération (/gettrackinfo)...");
                
                // --- ÉTAPE 2 : RÉCUPÉRATION DES INFOS (GETTRACKINFO) ---
                response = await fetch("https://api.17track.net/track/v2.2/gettrackinfo", {
                    method: "POST",
                    headers: { "17token": API_KEY, "Content-Type": "application/json" },
                    body: JSON.stringify([{ number: TRACKING_NUMBER }])
                });
                
                data = await response.json();
                
                if (data.data && data.data.accepted.length > 0) {
                    console.log("✅ SUCCÈS : Informations récupérées via la 2ème méthode !");
                    finalPackage = data.data.accepted[0];
                } else {
                    console.log("❌ ÉCHEC : Impossible de récupérer les infos même avec la 2ème méthode.");
                }
            } else {
                console.log("❌ ERREUR FATALE : Le numéro est invalide ou mal formaté.");
            }
        }

        console.log("------------------------------------------------");

        // --- AFFICHAGE DU RÉSULTAT FINAL ---
        if (finalPackage) {
            const track = finalPackage.track;
            
            // On vérifie s'il y a des infos de suivi
            if (track && (track.z0.length > 0 || track.z1.length > 0)) {
                // z1 = destination events, z0 = origin events
                // On prend le dernier événement
                const latest = track.z1?.[0] || track.z0?.[0];
                
                console.log("📦 ÉTAT DU COLIS :");
                console.log(`📍 Destination : ${finalPackage.recipientCountry || "Inconnue"}`);
                console.log(`ℹ️ Dernier statut : "${latest?.z || "Inconnu"}"`);
                console.log(`📅 Date : ${latest?.a}`);
                console.log(`🏢 Lieu : ${latest?.c || "Non précisé"}`);
                
                console.log("\n📜 Historique (3 derniers) :");
                const allEvents = [...(track.z0 || []), ...(track.z1 || [])]
                    .sort((a, b) => new Date(b.a) - new Date(a.a))
                    .slice(0, 3);
                
                allEvents.forEach(e => console.log(`   - [${e.a}] ${e.z}`));
                
            } else {
                console.log("⚠️ Colis connu, mais 17TRACK attend encore les données du transporteur.");
            }
        } else {
            console.log("❌ Aucun résultat à afficher.");
        }

    } catch (e) {
        console.error("Erreur script :", e);
    }
}

test17TrackRobust();
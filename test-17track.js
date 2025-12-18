// 1. Ta CLÉ API (Celle que tu m'as donnée)
const API_KEY = "1231D926B5CFB79297BB3D5059FC9FAF";

// 2. Le NUMÉRO DE SUIVI à tester
const TRACKING_NUMBER = "LE149936917FR";

async function test17Track() {
    console.log("🔵 Démarrage du test 17TRACK...");
    console.log(`🔑 Clé utilisée : ${API_KEY}`);
    console.log(`📦 Colis testé : ${TRACKING_NUMBER}`);

    try {
        const response = await fetch("https://api.17track.net/track/v2.2/register", {
            method: "POST",
            headers: {
                "17token": API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify([
                { number: TRACKING_NUMBER }
            ])
        });

        console.log(`\n📡 Statut HTTP : ${response.status}`);

        if (!response.ok) {
            console.error("❌ ERREUR HTTP : La requête a échoué.");
            console.error("Texte réponse:", await response.text());
            return;
        }

        const data = await response.json();
        console.log("\n✅ RÉPONSE JSON REÇUE :");
        console.log(JSON.stringify(data, null, 2));

        // Analyse rapide
        if (data.code === 0) {
            console.log("\n🎉 SUCCÈS ! L'API fonctionne et la clé est valide.");
            if (data.data.accepted.length > 0) {
                console.log("👉 Colis bien trouvé par 17TRACK.");
            } else {
                console.log("⚠️ Colis refusé ou non trouvé (vérifie le numéro).");
            }
        } else {
            console.error(`\n❌ ERREUR API (Code ${data.code}) : ${data.message}`);
            console.log("Explications possibles :");
            console.log("- Code -100 : Clé API invalide ou IP bloquée.");
            console.log("- Code -101 : Quota dépassé.");
        }

    } catch (error) {
        console.error("\n💀 CRASH DU SCRIPT :", error);
    }
}

test17Track();
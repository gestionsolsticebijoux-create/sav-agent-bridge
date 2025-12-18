import express from "express";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INSTRUCTIONS = `Tu es un extracteur d’informations SAV. Entrée : une capture d’écran d’un email SAV (image).
Objectif : extraire les identifiants client et commande visibles dans l’image, puis retourner UNIQUEMENT un JSON valide conforme au schéma ci-dessous.

Règles :
- N’invente rien. Si une donnée n’est pas visible avec certitude, mets null.
- Ne retourne aucun texte hors JSON.

Schéma JSON :
{
  "customer": { "email": null, "first_name": null, "last_name": null, "full_name": null },
  "order": { "order_number": null },
  "signals": { "best_lookup_key": null, "has_enough_to_lookup": false }
}
`;

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/sav/extract", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "missing image" });

    const b64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype};base64,${b64}`;

    const response = await client.responses.create({
      model: "gpt-5-nano",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: INSTRUCTIONS },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    });

    const text = response.output_text?.trim() ?? "";
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on " + port));

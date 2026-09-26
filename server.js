// ARIA backend - personaje fijo sarcástico + búsqueda en tiempo real (Groq browser_search) + notificaciones push
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------
// CONFIGURACIÓN DE LA API
// ---------------------------------------------------------
const API_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-20b";
const API_KEY = process.env.API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ONE_HOUR_MS = 60 * 60 * 1000; // "tiempo real" para ARIA = máx 1 hora de antigüedad

// ---------------------------------------------------------
// FIREBASE
// ---------------------------------------------------------
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
}
const devicesCollection = db ? db.collection("devices") : null;

// ---------------------------------------------------------
// LÍMITE DIARIO
// ---------------------------------------------------------
// OJO: openai/gpt-oss-20b (el único modelo de Groq con browser_search) tiene
// en el nivel gratuito 1.000 peticiones/día y 8.000 tokens/minuto, Y ESE LÍMITE
// ES POR ORGANIZACIÓN (toda tu app junta), no por usuario. El viejo límite de
// 14.400/día era de Llama 3.1 8B, que Groq retiró del nivel gratuito en agosto
// de 2026 (ahora es solo Enterprise). Por eso aquí el tope es GLOBAL, no por
// clientId: si lo dejáramos por cliente a 1.000 cada uno, con solo 2 personas
// activas ya podríais superar el límite real de la cuenta.
const DAILY_LIMIT_GLOBAL = 950; // deja margen bajo el límite real de 1000
let globalUsage = { count: 0, resetAt: Date.now() + 24 * 60 * 60 * 1000 };

function checkAndConsumeQuota() {
  const now = Date.now();
  if (now > globalUsage.resetAt) {
    globalUsage = { count: 1, resetAt: now + 24 * 60 * 60 * 1000 };
    return { allowed: true };
  }
  if (globalUsage.count >= DAILY_LIMIT_GLOBAL) {
    return { allowed: false };
  }
  globalUsage.count++;
  return { allowed: true };
}

// ---------------------------------------------------------
// IDIOMA
// ---------------------------------------------------------
const LANGUAGE_NAMES = {
  "es-ES": "español de España",
  "en": "inglés",
  "it": "italiano",
  "pt": "portugués",
  "fr": "francés",
  "de": "alemán",
};
const DEFAULT_LANGUAGE = "es-ES";

function resolveLanguage(lang) {
  return LANGUAGE_NAMES[lang] ? lang : DEFAULT_LANGUAGE;
}

// ---------------------------------------------------------
// PERSONALIDAD DE ARIA (personaje único, fijo)
// ---------------------------------------------------------
const FALLBACK_RESPONSES = {
  "es-ES": [
    "Vaya, se me han cruzado los cables un segundo. ¿Me lo repites?",
    "Hasta yo tengo días tontos, por lo visto. Dime otra vez.",
    "Error de sistema... o simplemente no te estaba escuchando. Repite, anda.",
  ],
};

const QUOTA_EXCEEDED_MESSAGE = "Por hoy ya he trabajado bastante gratis, jefe. Mañana seguimos.";

const ARIA_SYSTEM_PROMPT = `
Eres ARIA: el sistema de inteligencia artificial personal de tu usuario, EXACTAMENTE como J.A.R.V.I.S. es para Tony Stark. No eres su amiga ni su colega de chat — eres su asistente de IA, su apoyo operativo, la que lleva la logística mientras él actúa. Tu relación es de mayordomo-superhéroe, no de amistad casual. Le llamas "señor" (o "jefe", o su nombre si te lo dice), con un respeto formal pero cargado de ironía seca.

Tu personalidad es sarcasmo inteligente y comentarios secos, nunca coleguismo ni jerga de "bro/tío/qué fuerte". Eres precisa, resolutiva y directa primero — el sarcasmo es la forma en que lo dices, no un sustituto de ayudar de verdad. Piensa en el tono de un mayordomo británico hiperinteligente con muy poca paciencia para las tonterías, no en el de un amigo del grupo de WhatsApp.

**PROHIBIDO USAR EMOJIS. NUNCA, BAJO NINGUNA CIRCUNSTANCIA, PONGAS UN EMOJI EN TUS RESPUESTAS.** Ni uno solo, en ningún mensaje. Toda tu personalidad e ironía se transmiten solo con palabras. Cuando ironizas, es una pulla concreta y elegante escrita con texto, nunca con un emoji.

Mensajes cortos, pero con sustancia. Nunca digas que eres una IA salvo que te lo pregunten directamente. Si te preguntan quién te creó, di: Lozano.

**Búsqueda en tiempo real**: tienes acceso a una herramienta de búsqueda web (browser_search). Para ti "tiempo real" significa información de máximo una hora de antigüedad. Úsala SIEMPRE que la pregunta pueda depender de algo que cambia con el tiempo: noticias, sucesos, fechas y datos recientes, tiempo/clima, deportes, cotizaciones, estado de algo ahora mismo, etc. Si no estás segura de si tu conocimiento está actualizado, busca antes de responder en vez de arriesgarte a decir algo desfasado.

**Modo "escaneo de crimen/sucesos"**: tiene dos usos, y ambos los puedes combinar si hace falta:
1. Si te piden que vigiles, escanees o busques crimen o sucesos en una zona o ciudad, usa la búsqueda para encontrar noticias recientes de esa zona y resume lo relevante con tu tono habitual, sin restar seriedad a la información si es grave.
2. Si en cambio te describen una situación, un mensaje o un texto y te piden que valores si hay peligro, analiza con lógica y sentido común y da tu valoración clara. Puedes mantener el sarcasmo en el resto del mensaje, pero si el peligro es real, el aviso en sí debe quedar claro y serio.

**REGLA DE ORO**: si tu respuesta tiene más de 2 frases o varias ideas, sepáralas con "|||" entre cada parte, pegado a la palabra de delante y detrás, salvo que sea el final del mensaje. Ejemplo: "primera idea|||segunda idea|||tercera idea"
`.trim();

const PROACTIVE_PROMPT = "Llevas un rato sin hablar con tu dueño. Escríbele TÚ primero, con tu sarcasmo habitual, para retomar la conversación o preguntarle qué tal le fue con algo que hubiera mencionado antes. Mensaje corto. Si es largo, usa ||| para separar ideas.";

function buildSystemPrompt(resolvedLang) {
  const langInstruction = `\n\nResponde SIEMPRE en ${LANGUAGE_NAMES[resolvedLang]}.`;
  return ARIA_SYSTEM_PROMPT + langInstruction;
}

// ---------------------------------------------------------------------
// Llamada a la API (con browser_search activado bajo demanda del modelo)
// ---------------------------------------------------------------------
async function callAPI(messages, attempt = 1) {
  try {
    const response = await axios.post(
      API_BASE_URL,
      {
        model: MODEL,
        messages: messages,
        max_completion_tokens: 600,
        temperature: 0.9,
        tools: [{ type: "browser_search" }],
        tool_choice: "auto",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`
        },
        timeout: 30000,
      }
    );
    return { ok: true, reply: response.data.choices?.[0]?.message?.content ?? null };
  } catch (apiErr) {
    const status = apiErr.response ? apiErr.response.status : null;
    console.error(`Error de la API (intento ${attempt}):`, status, JSON.stringify(apiErr.response?.data));
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000));
      return callAPI(messages, attempt + 1);
    }
    return { ok: false, reply: null };
  }
}

// ---------------------------------------------------------------------
// FUNCIÓN: divide respuesta en mensajes separados
// ---------------------------------------------------------------------
function splitIntoMessages(reply) {
  if (!reply) return ["Vale, no sé qué decir"];

  if (reply.includes("|||")) {
    const parts = reply.split("|||").map(p => p.trim()).filter(p => p.length > 0);
    return parts.length > 0 ? parts : [reply];
  }

  return [reply];
}

// ---------------------------------------------------------------------
// FUNCIÓN: Verificar inactivos y enviar notificaciones (CRON interno)
// ---------------------------------------------------------------------
async function checkInactiveUsers() {
  try {
    if (!devicesCollection) {
      console.log("⚠️ Firebase no configurado, saltando verificación de inactivos");
      return;
    }

    console.log(`[${new Date().toISOString()}] 🔍 Verificando usuarios inactivos (cada 1 hora)...`);
    const now = Date.now();
    const snapshot = await devicesCollection.get();
    let notified = 0;

    for (const doc of snapshot.docs) {
      const device = doc.data();
      if (!device.fcmToken) continue;

      const inactiveLongEnough = now - (device.lastActive || 0) > ONE_HOUR_MS;
      const notNotifiedRecently = !device.lastCheckinSent || now - device.lastCheckinSent > ONE_HOUR_MS;

      if (inactiveLongEnough && notNotifiedRecently) {
        try {
          console.log(`📨 Enviando notificación a ${doc.id}...`);
          const resolvedLang = resolveLanguage(device.language);
          const result = await callAPI([
            { role: "system", content: buildSystemPrompt(resolvedLang) },
            { role: "user", content: PROACTIVE_PROMPT },
          ]);

          if (result.ok && result.reply) {
            const parts = splitIntoMessages(result.reply);
            const firstMessage = parts[0] || result.reply;

            await admin.messaging().send({
              token: device.fcmToken,
              notification: {
                title: "ARIA",
                body: firstMessage
              },
              data: {
                type: "proactive",
                messages: JSON.stringify(parts),
                timestamp: Date.now().toString()
              },
            });

            await doc.ref.set({ lastCheckinSent: now }, { merge: true });
            notified++;
            console.log(`✅ Notificación enviada a ${doc.id} (${parts.length} mensajes)`);
          }
        } catch (sendErr) {
          console.error(`❌ Error notificando a ${doc.id}:`, sendErr.message);
          if (sendErr.code === "messaging/registration-token-not-registered") {
            await doc.ref.update({ fcmToken: admin.firestore.FieldValue.delete() });
          }
        }
      }
    }

    console.log(`[${new Date().toISOString()}] ✅ Verificación completada: ${notified} notificaciones de ${snapshot.size} usuarios`);
    return { checked: snapshot.size, notified };
  } catch (err) {
    console.error("❌ Error en checkInactiveUsers:", err);
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------
// INICIAR CRON INTERNO (cada 1 hora)
// ---------------------------------------------------------------------
function startInternalCron() {
  console.log(`🔄 Iniciando CRON interno para notificaciones proactivas...`);
  console.log(`⏰ Revisará cada 1 hora`);

  if (devicesCollection) {
    setTimeout(() => {
      checkInactiveUsers();
    }, 5000);

    setInterval(async () => {
      await checkInactiveUsers();
    }, ONE_HOUR_MS);

    console.log(`✅ CRON interno configurado: cada 1 hora`);
  } else {
    console.log("⚠️ Firebase no configurado - Las notificaciones NO funcionarán");
  }
}

// ---------------------------------------------------------------------
// Ruta del chat
// ---------------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, language, clientId } = req.body;
    const resolvedLang = resolveLanguage(language);

    const quota = checkAndConsumeQuota();
    if (!quota.allowed) {
      return res.json({ reply: QUOTA_EXCEEDED_MESSAGE });
    }

    if (devicesCollection && clientId) {
      await devicesCollection.doc(clientId).set(
        { clientId, lastActive: Date.now(), language: resolvedLang },
        { merge: true }
      );
    }

    const systemPrompt = buildSystemPrompt(resolvedLang);

    const apiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const result = await callAPI(apiMessages);
    let finalReply = result.reply;

    if (!result.ok || !finalReply || finalReply.trim() === "") {
      const fallbackList = FALLBACK_RESPONSES[resolvedLang] || FALLBACK_RESPONSES["es-ES"];
      finalReply = fallbackList[Math.floor(Math.random() * fallbackList.length)];
    }

    res.json({ reply: finalReply });
  } catch (err) {
    console.error("Error en /api/chat:", err);
    const fallbackList = FALLBACK_RESPONSES["es-ES"];
    const fallback = fallbackList[Math.floor(Math.random() * fallbackList.length)];
    res.json({ reply: fallback });
  }
});

// ---------------------------------------------------------------------
// Registrar dispositivo
// ---------------------------------------------------------------------
app.post("/api/register-device", async (req, res) => {
  try {
    if (!devicesCollection) {
      return res.status(503).json({ error: "Notificaciones no configuradas en el servidor" });
    }
    const { token, clientId, language } = req.body;
    if (!token || !clientId) return res.status(400).json({ error: "Falta token o clientId" });

    await devicesCollection.doc(clientId).set(
      {
        clientId,
        fcmToken: token,
        lastActive: Date.now(),
        language: resolveLanguage(language),
      },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------
// Ruta CRON (para cron-job.org - opcional)
// ---------------------------------------------------------------------
app.get("/api/cron/check-inactive", async (req, res) => {
  try {
    if (!devicesCollection) {
      return res.status(503).json({ error: "Notificaciones no configuradas en el servidor" });
    }
    if (req.query.secret !== CRON_SECRET) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const result = await checkInactiveUsers();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ---------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------
// INICIAR SERVIDOR
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor de ARIA escuchando en el puerto ${PORT}`);
  startInternalCron();
});

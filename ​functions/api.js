// Cloudflare Worker API Gateway - VERSI LENGKAP & FIXED
const FIREBASE_WEB_API_KEY = "AIzaSyDGKQuxfKxF0rItQ52XX9gPyguo71hMXOo";
const AI_WORD_LIMIT_PER_DAY = 350;
const AI_GLOBAL_DAILY_CAP = 300000;
const BAD_WORDS = ["anjing", "bangsat", "kontol", "memek", "goblok"];
const AI_SYSTEM_PROMPT = "Kamu adalah asisten santai untuk komunitas pemain game Battle Of Warships. Jawab dengan ramah dan singkat dalam Bahasa Indonesia. Jangan memberi instruksi berbahaya, ilegal, atau eksplisit apapun alasannya, dan tetap sopan.";

// ---------- Helper Responses (FIXED CORS) ----------
function resp(statusCode, obj) {
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function filterText(text) {
  let out = text;
  BAD_WORDS.forEach(w => { out = out.replace(new RegExp(w, "gi"), "*".repeat(w.length)); });
  return out;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------- Verifikasi Firebase ID Token ----------
async function verifyIdToken(idToken) {
  if (!idToken) return null;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.users ? data.users[0].localId : null;
}

// ---------- Main Handler ----------
export default {
  async fetch(request, env, ctx) {
    // Menangani Preflight (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { 
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (request.method !== "POST") return resp(405, { ok: false, error: "Method not allowed" });

    let body;
    try { 
      body = await request.json(); 
    } catch { 
      return resp(400, { ok: false, error: "Body tidak valid" }); 
    }
    
    const { action, payload, idToken } = body;

    try {
      // Verifikasi Auth
      const authRequired = ["updateProfile", "updateSettings", "getAiHistory", "aiChat", "clearAiHistory"];
      if (authRequired.includes(action)) {
        const verifiedUid = await verifyIdToken(idToken);
        if (!verifiedUid || verifiedUid !== payload?.uid) {
          return resp(401, { ok: false, error: "Autentikasi tidak valid" });
        }
      }

      // Logic switch case (SAMA SEPERTI ASLIMU)
      switch (action) {
        case "getProfile": return resp(200, { ok: true, result: await getProfile(env, payload) });
        case "updateProfile": return resp(200, { ok: true, result: await updateProfile(env, payload) });
        case "updateSettings": return resp(200, { ok: true, result: await updateSettings(env, payload) });
        case "getAiHistory": return resp(200, { ok: true, result: await getAiHistory(env, payload) });
        case "aiChat": return resp(200, { ok: true, result: await aiChat(env, payload) });
        case "clearAiHistory": return resp(200, { ok: true, result: await clearAiHistory(env, payload) });
        default: return resp(400, { ok: false, error: "Aksi tidak dikenal" });
      }

    } catch (err) {
      return resp(500, { ok: false, error: err.message });
    }
  }
};

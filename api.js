// netlify/functions/api.js
// Gateway tunggal: semua request Supabase (Postgres via REST) + AI proxy lewat sini.
//
// ENV VARS wajib di-set di Netlify (Site settings > Environment variables):
//   SUPABASE_URL                -> https://mdfjonocepmernchopxa.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   -> service_role secret key (Project Settings > API), JANGAN pakai anon/publishable key
//   GROQ_API_KEY                -> console.groq.com
//   GEMINI_API_KEY              -> aistudio.google.com/apikey
//   OPENROUTER_API_KEY          -> openrouter.ai/keys

const FIREBASE_WEB_API_KEY = "AIzaSyDGKQuxfKxF0rItQ52XX9gPyguo71hMXOo"; // Firebase apiKey aman diexpose (bukan secret)
const AI_CHAR_LIMIT_PER_CHAT = 700;
const AI_CHAR_LIMIT_PER_HOUR = 5000;
const AI_GLOBAL_DAILY_CAP = 300000; // batas total karakter AI seluruh web per hari
const BAD_WORDS = ["anjing", "bangsat", "kontol", "memek", "goblok"];
const AI_SYSTEM_PROMPT = "Kamu adalah asisten santai untuk komunitas pemain game Battle Of Warships. Jawab dengan ramah dan singkat dalam Bahasa Indonesia. Jangan memberi instruksi berbahaya, ilegal, atau eksplisit apapun alasannya, dan tetap sopan.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { ok: false, error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body); } catch { return resp(400, { ok: false, error: "Body tidak valid" }); }
  const { action, payload, idToken } = body;

  try {
    // Aksi yang butuh identitas wajib verifikasi token dulu
    const authRequired = ["updateProfile", "updateSettings", "getAiHistory", "aiChat", "clearAiHistory"];
    if (authRequired.includes(action)) {
      const verifiedUid = await verifyIdToken(idToken);
      if (!verifiedUid || verifiedUid !== payload?.uid) {
        return resp(401, { ok: false, error: "Autentikasi tidak valid" });
      }
    }

    switch (action) {
      case "getProfile": return resp(200, { ok: true, result: await getProfile(payload) });
      case "updateProfile": return resp(200, { ok: true, result: await updateProfile(payload) });
      case "updateSettings": return resp(200, { ok: true, result: await updateSettings(payload) });
      case "getAiHistory": return resp(200, { ok: true, result: await getAiHistory(payload) });
      case "aiChat": return resp(200, { ok: true, result: await aiChat(payload) });
      case "clearAiHistory": return resp(200, { ok: true, result: await clearAiHistory(payload) });
      default: return resp(400, { ok: false, error: "Aksi tidak dikenal" });
    }
  } catch (err) {
    return resp(500, { ok: false, error: err.message });
  }
};

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function filterText(text) {
  let out = text;
  BAD_WORDS.forEach(w => { out = out.replace(new RegExp(w, "gi"), "*".repeat(w.length)); });
  return out;
}

// ---------- Verifikasi Firebase ID Token (tanpa Admin SDK) ----------
async function verifyIdToken(idToken) {
  if (!idToken) return null;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0]?.localId || null;
}

// ---------- Supabase (PostgREST) helper ----------
function sbHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}
async function sb(path, options = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: sbHeaders(options.headers)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Supabase error ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function sbUpsert(table, doc, conflictCol) {
  return sb(`${table}?on_conflict=${conflictCol}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(doc)
  });
}

// ---------- Profil & Settings ----------
function rowToProfile(row) {
  return { uid: row.uid, name: row.name, photoURL: row.photo_url, theme: row.theme, notif: row.notif };
}
async function getProfile({ uid, defaultName, defaultPhoto }) {
  const rows = await sb(`users?uid=eq.${encodeURIComponent(uid)}&select=*`);
  if (rows && rows.length) return rowToProfile(rows[0]);
  const fresh = { uid, name: defaultName || "Kapten", photo_url: defaultPhoto || "", theme: "dark", notif: true };
  await sb("users", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fresh) });
  return rowToProfile(fresh);
}
async function updateProfile({ uid, name, photoURL }) {
  await sbUpsert("users", { uid, name, photo_url: photoURL }, "uid");
  return { success: true };
}
async function updateSettings({ uid, theme, notif }) {
  const set = { uid };
  if (theme !== undefined) set.theme = theme;
  if (notif !== undefined) set.notif = notif;
  await sbUpsert("users", set, "uid");
  return { success: true };
}

// ---------- AI Chat ----------
async function getAiHistory({ uid }) {
  const rows = await sb(`ai_chats?uid=eq.${encodeURIComponent(uid)}&select=role,content&order=created_at.asc&limit=100`);
  return (rows || []).map(r => ({ role: r.role, content: r.content }));
}
async function clearAiHistory({ uid }) {
  await sb(`ai_chats?uid=eq.${encodeURIComponent(uid)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return { success: true };
}

async function checkRateLimit(uid) {
  const rows = await sb(`rate_limits?uid=eq.${encodeURIComponent(uid)}&select=*`);
  const doc = rows && rows[0];
  const now = Date.now();
  if (!doc || now > doc.reset_at) {
    const resetAt = now + 60 * 60 * 1000;
    await sbUpsert("rate_limits", { uid, chars_used: 0, reset_at: resetAt }, "uid");
    return { charsUsed: 0, resetAt };
  }
  return { charsUsed: doc.chars_used, resetAt: doc.reset_at };
}
async function incrementRateLimit(uid, chars, resetAt) {
  await sb("rpc/increment_rate_limit", {
    method: "POST",
    body: JSON.stringify({ p_uid: uid, p_chars: chars, p_reset_at: resetAt })
  });
}

async function checkGlobalCap() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sb(`global_usage?date=eq.${today}&select=chars_used`);
  return rows && rows[0] ? rows[0].chars_used : 0;
}
async function incrementGlobalCap(chars) {
  const today = new Date().toISOString().slice(0, 10);
  await sb("rpc/increment_global_usage", {
    method: "POST",
    body: JSON.stringify({ p_date: today, p_chars: chars })
  });
}

async function aiChat({ uid, message, provider }) {
  if (!message || message.length > AI_CHAR_LIMIT_PER_CHAT) {
    throw new Error(`Maksimal ${AI_CHAR_LIMIT_PER_CHAT} karakter per chat`);
  }

  const globalUsed = await checkGlobalCap();
  if (globalUsed > AI_GLOBAL_DAILY_CAP) {
    throw new Error("Layanan AI sedang penuh hari ini, coba lagi besok ya.");
  }

  const limit = await checkRateLimit(uid);
  if (limit.charsUsed + message.length > AI_CHAR_LIMIT_PER_HOUR) {
    const minutesLeft = Math.ceil((limit.resetAt - Date.now()) / 60000);
    throw new Error(`Limit karakter per jam habis. Coba lagi dalam ${minutesLeft} menit.`);
  }

  const cleanMessage = filterText(message);

  const historyRows = await sb(`ai_chats?uid=eq.${encodeURIComponent(uid)}&select=role,content&order=created_at.desc&limit=10`);
  const recentHistory = (historyRows || []).reverse().map(r => ({ role: r.role, content: r.content }));

  const reply = filterText(await callAiProvider(provider, [...recentHistory, { role: "user", content: cleanMessage }]));

  const now = new Date().toISOString();
  await sb("ai_chats", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      { uid, role: "user", content: cleanMessage, created_at: now },
      { uid, role: "assistant", content: reply, created_at: now }
    ])
  });

  const totalChars = cleanMessage.length + reply.length;
  await incrementRateLimit(uid, totalChars, limit.resetAt);
  await incrementGlobalCap(totalChars);

  return { reply };
}

// ---------- AI Providers ----------
async function callAiProvider(provider, messages) {
  switch (provider) {
    case "gemini": return callGemini(messages);
    case "openrouter": return callOpenRouter(messages);
    case "groq":
    default: return callGroq(messages);
  }
}

async function callGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 400,
      messages: [{ role: "system", content: AI_SYSTEM_PROMPT }, ...messages]
    })
  });
  if (!res.ok) throw new Error("AI provider error (Groq)");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Maaf, gak bisa jawab sekarang.";
}

async function callOpenRouter(messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://battle-of-warships-id.netlify.app",
      "X-Title": "Battle Of Warships ID"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct:free",
      max_tokens: 400,
      messages: [{ role: "system", content: AI_SYSTEM_PROMPT }, ...messages]
    })
  });
  if (!res.ok) throw new Error("AI provider error (OpenRouter)");
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Maaf, gak bisa jawab sekarang.";
}

async function callGemini(messages) {
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
        contents
      })
    }
  );
  if (!res.ok) throw new Error("AI provider error (Gemini)");
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "Maaf, gak bisa jawab sekarang.";
}

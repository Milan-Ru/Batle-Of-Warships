// Cloudflare Worker API Gateway
// Pastikan Environment Variables sudah di-set di Dashboard Cloudflare Pages:
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY

const FIREBASE_WEB_API_KEY = "AIzaSyDGKQuxfKxF0rItQ52XX9gPyguo71hMXOo"; // Aman diexpose
const AI_WORD_LIMIT_PER_DAY = 350;
const AI_GLOBAL_DAILY_CAP = 300000;
const BAD_WORDS = ["anjing", "bangsat", "kontol", "memek", "goblok"];
const AI_SYSTEM_PROMPT = "Kamu adalah asisten santai untuk komunitas pemain game Battle Of Warships. Jawab dengan ramah dan singkat dalam Bahasa Indonesia. Jangan memberi instruksi berbahaya, ilegal, atau eksplisit apapun alasannya, dan tetap sopan.";

// ---------- Helper Responses ----------
function resp(statusCode, obj) {
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { "Content-Type": "application/json" }
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
  return data.users?.[0]?.localId || null;
}

// ---------- Supabase (PostgREST) helper ----------
function sbHeaders(env, extra = {}) {
  return {
    "Content-Type": "application/json",
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function sb(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: sbHeaders(env, options.headers)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Supabase error ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function sbUpsert(env, table, doc, conflictCol) {
  return sb(env, `${table}?on_conflict=${conflictCol}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(doc)
  });
}

// ---------- Profil & Settings ----------
function rowToProfile(row) {
  return { uid: row.uid, name: row.name, photoURL: row.photo_url, theme: row.theme, notif: row.notif };
}

async function nameTaken(env, name, excludeUid) {
  const rows = await sb(env, `users?name=eq.${encodeURIComponent(name)}&select=uid`);
  return !!(rows && rows.some(r => r.uid !== excludeUid));
}

async function ensureUniqueName(env, baseName, excludeUid) {
  let candidate = baseName;
  let suffix = 1;
  while (await nameTaken(env, candidate, excludeUid)) {
    suffix++;
    candidate = `${baseName}${suffix}`;
  }
  return candidate;
}

async function getProfile(env, { uid, defaultName, defaultPhoto }) {
  const rows = await sb(env, `users?uid=eq.${encodeURIComponent(uid)}&select=*`);
  if (rows && rows.length) return { ...rowToProfile(rows[0]), isNewUser: false };
  const uniqueName = await ensureUniqueName(env, defaultName || "Kapten", uid);
  const fresh = { uid, name: uniqueName, photo_url: defaultPhoto || "", theme: "dark", notif: true };
  await sb(env, "users", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fresh) });
  return { ...rowToProfile(fresh), isNewUser: true };
}

async function updateProfile(env, { uid, name, photoURL }) {
  if (await nameTaken(env, name, uid)) throw new Error("Nama sudah dipakai, coba nama lain");
  await sbUpsert(env, "users", { uid, name, photo_url: photoURL }, "uid");
  return { success: true };
}

async function updateSettings(env, { uid, theme, notif }) {
  const set = { uid };
  if (theme !== undefined) set.theme = theme;
  if (notif !== undefined) set.notif = notif;
  await sbUpsert(env, "users", set, "uid");
  return { success: true };
}

// ---------- AI Chat ----------
async function getAiHistory(env, { uid }) {
  const rows = await sb(env, `ai_chats?uid=eq.${encodeURIComponent(uid)}&select=role,content&order=created_at.asc&limit=100`);
  return (rows || []).map(r => ({ role: r.role, content: r.content }));
}

async function clearAiHistory(env, { uid }) {
  await sb(env, `ai_chats?uid=eq.${encodeURIComponent(uid)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return { success: true };
}

async function checkRateLimit(env, uid) {
  const rows = await sb(env, `rate_limits?uid=eq.${encodeURIComponent(uid)}&select=*`);
  const doc = rows && rows[0];
  const now = Date.now();
  if (!doc || now > doc.reset_at) {
    const resetAt = now + 24 * 60 * 60 * 1000;
    await sbUpsert(env, "rate_limits", { uid, chars_used: 0, reset_at: resetAt }, "uid");
    return { wordsUsed: 0, resetAt };
  }
  return { wordsUsed: doc.chars_used, resetAt: doc.reset_at };
}

async function incrementRateLimit(env, uid, words, resetAt) {
  await sb(env, "rpc/increment_rate_limit", {
    method: "POST",
    body: JSON.stringify({ p_uid: uid, p_chars: words, p_reset_at: resetAt })
  });
}

async function checkGlobalCap(env) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sb(env, `global_usage?date=eq.${today}&select=chars_used`);
  return rows && rows[0] ? rows[0].chars_used : 0;
}

async function incrementGlobalCap(env, chars) {
  const today = new Date().toISOString().slice(0, 10);
  await sb(env, "rpc/increment_global_usage", {
    method: "POST",
    body: JSON.stringify({ p_date: today, p_chars: chars })
  });
}

// ---------- AI Provider (Groq) ----------
async function callGroq(env, messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GROQ_API_KEY}` },
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

async function aiChat(env, { uid, message }) {
  if (!message || !message.trim()) throw new Error("Pesan gak boleh kosong");

  const globalUsed = await checkGlobalCap(env);
  if (globalUsed > AI_GLOBAL_DAILY_CAP) {
    throw new Error("Layanan AI sedang penuh hari ini, coba lagi besok ya.");
  }

  const messageWords = countWords(message);
  const limit = await checkRateLimit(env, uid);
  
  if (limit.wordsUsed + messageWords > AI_WORD_LIMIT_PER_DAY) {
    throw new Error("Limit chat AI harian kamu udah habis. Coba lagi 24 jam lagi ya.");
  }

  const cleanMessage = filterText(message);

  const historyRows = await sb(env, `ai_chats?uid=eq.${encodeURIComponent(uid)}&select=role,content&order=created_at.desc&limit=10`);
  const recentHistory = (historyRows || []).reverse().map(r => ({ role: r.role, content: r.content }));

  const reply = filterText(await callGroq(env, [...recentHistory, { role: "user", content: cleanMessage }]));

  const now = new Date().toISOString();
  await sb(env, "ai_chats", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      { uid, role: "user", content: cleanMessage, created_at: now },
      { uid, role: "assistant", content: reply, created_at: now }
    ])
  });

  await incrementRateLimit(env, uid, messageWords + countWords(reply), limit.resetAt);
  await incrementGlobalCap(env, cleanMessage.length + reply.length);

  return { reply };
}

// ---------- MAIN HANDLER (Cloudflare Pages Functions) ----------
// PENTING: Pages Functions WAJIB pakai nama export onRequestPost / onRequest / dst.
// "export default { fetch(request, env, ctx) {...} }" itu format Cloudflare Worker
// yang berdiri sendiri (lewat wrangler) — beda sama Pages Functions, jadi gak
// pernah kepanggil sama sekali. Itu sebabnya /api selalu gagal.
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return resp(400, { ok: false, error: "Body tidak valid" });
  }

  const { action, payload, idToken } = body;

  try {
    const authRequired = ["updateProfile", "updateSettings", "getAiHistory", "aiChat", "clearAiHistory"];
    if (authRequired.includes(action)) {
      const verifiedUid = await verifyIdToken(idToken);
      if (!verifiedUid || verifiedUid !== payload?.uid) {
        return resp(401, { ok: false, error: "Autentikasi tidak valid" });
      }
    }

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

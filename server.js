const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET,
  ADMIN_EMAIL, ADMIN_PASSWORD_HASH, ADMIN_ACCESS_KEY,
  BASE_URL = "http://localhost:3000", PORT = 3000, GOOGLE_CLIENT_ID = "",
} = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD_HASH, ADMIN_ACCESS_KEY })) {
  if (!v) { console.error(`缺少環境變數 ${k}（請參考 .env.example）`); process.exit(1); }
}
const SCHOOL = "@hlc.edu.tw";
const SCHOOL_HD = "hlc.edu.tw";
const SECURE = BASE_URL.startsWith("https");

/* 前端頁面：內嵌 <script> 抽成外部檔案，CSP 即可移除 script 的 'unsafe-inline' */
function splitPage(html, name) {
  let js = "";
  const out = html.replace(/<script>([\s\S]*?)<\/script>/, (m, code) => { js = code; return `<script src="/assets/${name}.js" defer></script>`; });
  return { html: out, js };
}
const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), "utf8");   // 字面路徑，讓 Vercel 追蹤得到
const PAGES = {
  index: splitPage(read("views", "index.html"), "index"),
  login: splitPage(read("views", "admin-login.html"), "login"),
  admin: splitPage(read("views", "admin.html"), "admin"),
  css: read("views", "ui.css"),
  jszip: read("node_modules", "jszip", "dist", "jszip.min.js"),
  icon: read("icon.svg"),
};

// 服務金鑰只存在於伺服器，瀏覽器永遠拿不到
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/* ---------- 工具 ---------- */
const b64 = b => Buffer.from(b).toString("base64url");
const sign = s => crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function makeToken(payload, ttlSec) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlSec * 1000 }));
  return body + "." + sign(body);
}
function readToken(t) {
  if (!t) return null;
  const [body, sig] = t.split(".");
  if (!body || !sig || !eq(sig, sign(body))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url")); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(c => c[0]));
function setCookie(res, name, val, { maxAge, strict = false } = {}) {
  res.append("Set-Cookie", `${name}=${val}; Path=/; HttpOnly; SameSite=${strict ? "Strict" : "Lax"}${SECURE ? "; Secure" : ""}${maxAge != null ? `; Max-Age=${maxAge}` : ""}`);
}
const clearCookie = (res, name) => setCookie(res, name, "", { maxAge: 0 });
const userOf = req => { const p = readToken(cookies(req).ks); return p && p.t === "u" ? p : null; };
const adminOf = req => { const p = readToken(cookies(req).ka); return p && p.t === "a" ? p : null; };
const notFound = (res) => res.status(404).type("text/plain").send("Not found");
const clientIp = req => String(req.ip || "");   // 交給 Express trust proxy 解析，避免被偽造的 X-Forwarded-For 欺騙

/* 限流：優先存 Supabase（serverless 多實例也有效），資料表不存在時退回記憶體 */
const hits = new Map();
function limitedMem(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();
async function limited(key, max, windowMs) {
  try {
    const { error: e1 } = await db.from("rate_limits").insert({ key });
    if (e1) throw e1;
    const since = new Date(Date.now() - windowMs).toISOString();
    const { count, error: e2 } = await db.from("rate_limits").select("key", { count: "exact", head: true }).eq("key", key).gte("created_at", since);
    if (e2) throw e2;
    if (Math.random() < 0.02) db.from("rate_limits").delete().lt("created_at", new Date(Date.now() - 86400e3).toISOString()).then(() => {}, () => {});
    return count > max;
  } catch { return limitedMem(key, max, windowMs); }
}
const audit = (req, action, target = "") => db.from("admin_audit").insert({ action, target: String(target), ip: clientIp(req) }).then(() => {}, () => {});

async function verifyPassword(pw) {
  const [salt, hash] = ADMIN_PASSWORD_HASH.split(":");
  const h = await new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k.toString("hex"))));
  return eq(h, hash);
}

/* ---------- 輸入清理 ---------- */
const str = (v, n = 120) => typeof v === "string" ? v.slice(0, n) : "";
function cleanMeta(cm) {
  cm = cm && typeof cm === "object" ? cm : {};
  const g = cm.geo;
  const geoOk = g && typeof g.lat === "number" && typeof g.lng === "number" && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180;
  return {
    screen: str(cm.screen, 40), language: str(cm.language, 80), platform: str(cm.platform, 40),
    timezone: str(cm.timezone, 60), gpu: str(cm.gpu, 160), cores: str(cm.cores, 20), memory: str(cm.memory, 20),
    battery: str(cm.battery, 40), network: str(cm.network, 60),
    touch: Number.isFinite(cm.touch) ? cm.touch : null,
    geo: geoOk ? { lat: g.lat, lng: g.lng, accuracy: Math.max(0, Math.round(Number(g.accuracy) || 0)) } : null,
  };
}
const JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;

/* ---------- App ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleusercontent.com; media-src 'self' blob: mediastream:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
  });
  if (SECURE) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.json({ limit: "4mb" }));
// 所有寫入操作必須帶自訂標頭（簡易 CSRF 防護，搭配 SameSite cookie）
app.use((req, res, next) => {
  if (req.method !== "GET" && req.headers["x-requested-with"] !== "fetch") return notFound(res);
  next();
});

/* --- 前台與靜態資源 --- */
const cached = res => res.set("Cache-Control", "public, max-age=300");
app.get("/", (req, res) => res.type("html").send(PAGES.index.html));
app.get([("/icon.svg"), "/favicon.ico"], (req, res) => cached(res).type("image/svg+xml").send(PAGES.icon));
app.get("/assets/ui.css", (req, res) => cached(res).type("css").send(PAGES.css));
app.get("/assets/index.js", (req, res) => res.type("js").send(PAGES.index.js));
app.get("/assets/login.js", (req, res) => res.type("js").send(PAGES.login.js));
app.get("/assets/admin.js", (req, res) => adminOf(req) ? res.type("js").send(PAGES.admin.js) : notFound(res));

function parseUA(ua = "") {
  let os = "未知系統";
  if (/iPhone/i.test(ua)) os = "iPhone (iOS)";
  else if (/iPad/i.test(ua)) os = "iPad (iPadOS)";
  else if (/Android/i.test(ua)) {
    const m = ua.match(/Android\s+([\d.]+)(?:;\s*([^;)]+))?/i);
    os = m ? `Android ${m[1]}${m[2] ? " (" + m[2].trim() + ")" : ""}` : "Android";
  } else if (/Windows NT 10\.0/i.test(ua)) os = "Windows 10/11";
  else if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  let browser = "未知瀏覽器";
  if (/Line\//i.test(ua)) browser = "LINE 內建瀏覽器";
  else if (/Instagram/i.test(ua)) browser = "Instagram 內建瀏覽器";
  else if (/FBAN|FBAV/i.test(ua)) browser = "Facebook 內建瀏覽器";
  else if (/EdgA?\/([\d.]+)/i.test(ua)) browser = "Edge " + RegExp.$1.split(".")[0];
  else if (/OPR\/([\d.]+)/i.test(ua)) browser = "Opera " + RegExp.$1.split(".")[0];
  else if (/CriOS\/([\d.]+)/i.test(ua)) browser = "Chrome (iOS) " + RegExp.$1.split(".")[0];
  else if (/FxiOS\/([\d.]+)/i.test(ua)) browser = "Firefox (iOS) " + RegExp.$1.split(".")[0];
  else if (/Chrome\/([\d.]+)/i.test(ua)) browser = "Chrome " + RegExp.$1.split(".")[0];
  else if (/Firefox\/([\d.]+)/i.test(ua)) browser = "Firefox " + RegExp.$1.split(".")[0];
  else if (/Version\/([\d.]+).*Safari/i.test(ua)) browser = "Safari " + RegExp.$1.split(".")[0];
  else if (/Safari/i.test(ua)) browser = "Safari";

  const type = /Mobile|iPhone|Android.*Mobile/i.test(ua) ? "手機" : /iPad|Tablet/i.test(ua) ? "平板" : "電腦";
  return `${type} · ${os} · ${browser}`;
}

function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}

// 讀取後合併寫入 user_metadata
async function patchMeta(uid, fn) {
  const { data } = await db.auth.admin.getUserById(uid).catch(() => ({}));
  const md = data?.user?.user_metadata || {};
  return db.auth.admin.updateUserById(uid, { user_metadata: { ...md, ...fn(md) } });
}
const hardwarePatch = (md, cm) => ({
  kk_geo: cm.geo || md.kk_geo || null, kk_gpu: cm.gpu || md.kk_gpu || "", kk_cores: cm.cores || md.kk_cores || "",
  kk_memory: cm.memory || md.kk_memory || "", kk_battery: cm.battery || md.kk_battery || "",
  kk_network: cm.network || md.kk_network || "", kk_touch: cm.touch ?? md.kk_touch ?? null,
});
// 是否已完成實拍：優先看 user_profiles 資料表，若資料表尚未建立則檢查 user_metadata
async function hasVerified(uid, mdFallback = null) {
  try {
    const { data, error } = await db.from("user_profiles").select("user_id").eq("user_id", uid).maybeSingle();
    if (!error && data) return true;
  } catch {}
  let md = mdFallback;
  if (!md) {
    const { data } = await db.auth.admin.getUserById(uid).catch(() => ({}));
    md = data?.user?.user_metadata || {};
  }
  return Boolean(md.kk_selfie && md.kk_selfie_right && md.kk_selfie_left);
}

app.post("/api/auth/google", async (req, res) => {
  if (await limited("oauth:" + clientIp(req), 30, 600e3)) return res.status(429).json({ error: "Too many requests" });
  const { idToken, nonce, clientMeta } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "Missing token" });
  const claims = decodeJwtPayload(idToken);
  // 先用 token 內容擋掉非學校帳號，避免在 Supabase 建出帳號
  if (!String(claims.email || "").toLowerCase().endsWith(SCHOOL) || (claims.hd && claims.hd !== SCHOOL_HD) || claims.email_verified === false) {
    return res.status(403).json({ error: "domain" });
  }
  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let { data, error } = await authClient.auth.signInWithIdToken({
    provider: "google",
    token: String(idToken),
    ...(nonce ? { nonce: String(nonce) } : {}),
  });
  if (error && nonce) {
    const retry = await authClient.auth.signInWithIdToken({ provider: "google", token: String(idToken) });
    data = retry.data;
    error = retry.error;
  }
  if (error || !data?.user) return res.status(401).json({ error: "oauth", detail: error?.message || "" });
  const u = data.user, email = (u.email || "").toLowerCase();
  if (!email.endsWith(SCHOOL)) {
    if (Date.now() - new Date(u.created_at).getTime() < 120e3) await db.auth.admin.deleteUser(u.id).catch(() => {});
    return res.status(403).json({ error: "domain" });
  }
  const md = u.user_metadata || {};
  const ua = str(req.headers["user-agent"], 300);
  const cm = cleanMeta(clientMeta);
  const deviceInfo = parseUA(ua) + (cm.screen ? ` (${cm.screen})` : "");

  const googleInfo = {
    sub: claims.sub || md.sub || md.provider_id || "",
    email,
    email_verified: true,
    hd: claims.hd || SCHOOL_HD,
    name: str(claims.name || md.full_name || md.name, 80),
    given_name: str(claims.given_name || md.given_name, 40),
    family_name: str(claims.family_name || md.family_name, 40),
    picture: str(claims.picture || md.avatar_url || md.picture, 300),
    locale: str(claims.locale || md.locale || cm.language, 20),
  };
  const verified = await hasVerified(u.id, md);
  await db.auth.admin.updateUserById(u.id, {
    user_metadata: {
      ...md, ...googleInfo,
      kk_login_count: (Number(md.kk_login_count) || 0) + 1,
      kk_last_login_at: new Date().toISOString(),
      kk_last_device: deviceInfo, kk_last_ua: ua, kk_last_ip: clientIp(req),
      kk_timezone: cm.timezone || md.kk_timezone || "",
      ...hardwarePatch(md, cm),
    },
  }).catch(() => {});

  setCookie(res, "ks", makeToken({
    t: "u", id: u.id, email, name: googleInfo.name, picture: googleInfo.picture, sub: googleInfo.sub,
    given_name: googleInfo.given_name, family_name: googleInfo.family_name, hd: googleInfo.hd, locale: googleInfo.locale,
    verified,
  }, 8 * 3600));
  res.json({ email, name: googleInfo.name, picture: googleInfo.picture, needsVerification: !verified });
});

app.get("/api/me", async (req, res) => {
  const base = { googleClientId: GOOGLE_CLIENT_ID, baseUrl: BASE_URL.replace(/\/$/, "") };
  const u = userOf(req);
  if (!u) return res.json({ user: null, ...base });
  let needsVerification = !u.verified;
  if (needsVerification && await hasVerified(u.id)) needsVerification = false;
  res.json({ user: { email: u.email, name: u.name, picture: u.picture, needsVerification }, ...base });
});

app.post("/api/verify-profile", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "請先登入" });
  const { selfieFront, selfieRight, selfieLeft, clientMeta } = req.body || {};
  const imgs = [selfieFront, selfieRight, selfieLeft];
  for (const img of imgs) {
    if (typeof img !== "string" || !img.startsWith("data:image/")) return res.status(400).json({ error: "請完成正面、向右、向左三張清晰臉部拍攝" });
    if (img.length > 1500000) return res.status(400).json({ error: "照片檔案過大，請重拍" });
  }
  const cm = cleanMeta(clientMeta);
  const nowIso = new Date().toISOString();
  // 同時嘗試寫入 user_profiles 與 user_metadata，確保不論是否執行額外 SQL 都能可靠儲存與顯示
  await db.from("user_profiles").upsert({
    user_id: u.id, selfie_front: selfieFront, selfie_right: selfieRight, selfie_left: selfieLeft, selfie_at: nowIso,
  }).then(() => {}, () => {});
  await patchMeta(u.id, md => ({
    ...hardwarePatch(md, cm),
    kk_selfie: selfieFront,
    kk_selfie_right: selfieRight,
    kk_selfie_left: selfieLeft,
    kk_selfie_at: nowIso,
    kk_last_ip: clientIp(req),
  })).catch(() => {});
  setCookie(res, "ks", makeToken({ ...u, verified: true }, 8 * 3600));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => { clearCookie(res, "ks"); res.json({ ok: true }); });

app.post("/api/proverbs", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "請先登入" });
  if (!u.verified && !(await hasVerified(u.id))) return res.status(403).json({ error: "請先完成身分核實" });
  // 每個人可不限次數上傳資料，每次皆建立獨立卡片
  const content = String(req.body?.content ?? "").trim(), author = String(req.body?.author ?? "").trim();
  if (!content || content.length > 100 || !author || author.length > 30) return res.status(400).json({ error: "內容格式不正確" });

  const ua = str(req.headers["user-agent"], 300);
  const cm = cleanMeta(req.body?.clientMeta);
  const deviceInfo = parseUA(ua) + (cm.screen ? ` (${cm.screen})` : "");
  const ip = clientIp(req);

  patchMeta(u.id, md => ({
    ...hardwarePatch(md, cm),
    kk_last_device: deviceInfo,
    kk_last_ua: ua,
    kk_last_ip: ip,
    kk_timezone: cm.timezone || md.kk_timezone || "",
  })).catch(() => {});

  const fullMeta = {
    google_sub: u.sub || null, given_name: u.given_name || null, family_name: u.family_name || null,
    picture: u.picture || null, hd: u.hd || null, locale: u.locale || cm.language || null,
    device_info: deviceInfo, user_agent: ua, ip_address: ip,
    platform: cm.platform || null, screen: cm.screen || null, timezone: cm.timezone || null, geo: cm.geo,
    gpu: cm.gpu || null, cores: cm.cores || null, memory: cm.memory || null, battery: cm.battery || null, network: cm.network || null,
  };
  // 先嘗試寫入完整擴充欄位，若 Supabase 尚未執行 ALTER TABLE 則自動儲存於基本欄位
  let { error } = await db.from("proverbs").insert({
    user_id: u.id, user_email: u.email, user_name: u.name || null, user_avatar: u.picture || null,
    google_sub: u.sub || null, user_meta: fullMeta, device_info: deviceInfo, user_agent: ua, ip_address: ip, content, author,
  });
  if (error) {
    const retry = await db.from("proverbs").insert({
      user_id: u.id, user_email: u.email, user_name: JSON.stringify({ name: u.name || "", ...fullMeta }), content, author,
    });
    error = retry.error;
  }
  if (error) return res.status(500).json({ error: "送出失敗" });
  res.json({ ok: true });
});

/* --- 後台（未驗證一律回 404，不洩漏存在與否） --- */
const keyOk = v => eq(v || "", ADMIN_ACCESS_KEY);

app.get("/adminusercontrol", (req, res) => {
  if (adminOf(req)) return res.type("html").send(PAGES.admin.html);
  if (!keyOk(req.query.k)) return notFound(res);
  res.type("html").send(PAGES.login.html);
});
app.get("/adminusercontrol/jszip.js", (req, res) => {
  if (!adminOf(req)) return notFound(res);
  res.type("js").send(PAGES.jszip);
});

app.post("/api/admin/login", async (req, res) => {
  if (!keyOk(req.headers["x-access-key"])) return notFound(res);
  if (await limited("login:" + clientIp(req), 5, 900e3)) return res.status(429).json({ error: "嘗試次數過多，請稍後再試" });
  const { email, password } = req.body || {};
  const emailOk = eq(String(email).toLowerCase(), ADMIN_EMAIL.toLowerCase());
  const pwOk = await verifyPassword(String(password));   // 兩者都計算，避免時間差
  await new Promise(r => setTimeout(r, 400));
  if (!(emailOk && pwOk)) { audit(req, "login_fail"); return res.status(401).json({ error: "帳號或密碼錯誤" }); }
  audit(req, "login_ok");
  setCookie(res, "ka", makeToken({ t: "a", jti: crypto.randomUUID() }, 3600), { strict: true });
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { clearCookie(res, "ka"); res.json({ ok: true }); });

app.get("/api/admin/proverbs", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const { data, error } = await db.from("proverbs").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "讀取失敗" });
  res.json(data);
});

// 已登入帳號完整彙整（包含實拍三張照片、定位、硬體環境、登入與貼文次數）
app.get("/api/admin/users", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const [{ data: usersData, error: uErr }, { data: proverbsData }, profilesRes] = await Promise.all([
    db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    db.from("proverbs").select("*").order("created_at", { ascending: false }),
    db.from("user_profiles").select("user_id,selfie_front,selfie_right,selfie_left,selfie_at").then(r => r, () => ({ data: [] })),
  ]);
  if (uErr) return res.status(500).json({ error: "讀取帳號失敗" });
  const profileMap = Object.fromEntries(((profilesRes && profilesRes.data) || []).map(p => [p.user_id, p]));

  const postStats = {};
  for (const p of (proverbsData || [])) {
    const uid = p.user_id || p.user_email;
    if (!postStats[uid]) {
      postStats[uid] = {
        count: 0, lastPostAt: p.created_at || "", lastDevice: "", lastUa: "", lastIp: "",
        lastGeo: null, gpu: "", cores: "", memory: "", battery: "", network: "", timezone: "", locale: "",
      };
    }
    postStats[uid].count++;
    let pMeta = p.user_meta || {};
    if (typeof p.user_name === "string" && p.user_name.startsWith("{")) {
      try { pMeta = { ...JSON.parse(p.user_name), ...pMeta }; } catch {}
    }
    const st = postStats[uid];
    if (!st.lastDevice && (p.device_info || pMeta.device_info)) st.lastDevice = p.device_info || pMeta.device_info;
    if (!st.lastUa && (p.user_agent || pMeta.user_agent)) st.lastUa = p.user_agent || pMeta.user_agent;
    if (!st.lastIp && (p.ip_address || pMeta.ip_address)) st.lastIp = p.ip_address || pMeta.ip_address;
    if (!st.lastGeo && pMeta.geo) st.lastGeo = pMeta.geo;
    if (!st.gpu && pMeta.gpu) st.gpu = pMeta.gpu;
    if (!st.cores && pMeta.cores) st.cores = pMeta.cores;
    if (!st.memory && pMeta.memory) st.memory = pMeta.memory;
    if (!st.battery && pMeta.battery) st.battery = pMeta.battery;
    if (!st.network && pMeta.network) st.network = pMeta.network;
    if (!st.timezone && pMeta.timezone) st.timezone = pMeta.timezone;
    if (!st.locale && pMeta.locale) st.locale = pMeta.locale;
  }

  const list = (usersData?.users || []).map(u => {
    const md = u.user_metadata || {};
    const pf = profileMap[u.id] || {};
    const st = postStats[u.id] || postStats[u.email] || { count: 0 };
    const selfie = pf.selfie_front || md.kk_selfie || "";
    const selfieRight = pf.selfie_right || md.kk_selfie_right || "";
    const selfieLeft = pf.selfie_left || md.kk_selfie_left || "";
    const selfieAt = pf.selfie_at || md.kk_selfie_at || "";
    return {
      id: u.id,
      email: u.email || "",
      name: md.name || md.full_name || "",
      given_name: md.given_name || "",
      family_name: md.family_name || "",
      picture: md.picture || md.avatar_url || "",
      has_photos: Boolean(selfie),
      selfie,
      selfie_right: selfieRight,
      selfie_left: selfieLeft,
      selfie_at: selfieAt,
      google_sub: md.sub || md.provider_id || "",
      email_verified: md.email_verified ?? Boolean(u.email_confirmed_at),
      hd: md.hd || (u.email || "").split("@")[1] || "",
      locale: md.locale || st.locale || "",
      timezone: md.kk_timezone || st.timezone || "",
      created_at: u.created_at,
      last_sign_in_at: md.kk_last_login_at || u.last_sign_in_at || u.created_at,
      last_post_at: st.lastPostAt || "",
      login_count: Number(md.kk_login_count) || 1,
      post_count: st.count || 0,
      last_device: md.kk_last_device || st.lastDevice || "尚未記錄裝置",
      last_ua: md.kk_last_ua || st.lastUa || "",
      last_ip: md.kk_last_ip || st.lastIp || "",
      geo: md.kk_geo || st.lastGeo || null,
      gpu: md.kk_gpu || st.gpu || "",
      cores: md.kk_cores || st.cores || "",
      memory: md.kk_memory || st.memory || "",
      battery: md.kk_battery || st.battery || "",
      network: md.kk_network || st.network || "",
    };
  }).sort((a, b) => new Date(b.last_sign_in_at || 0) - new Date(a.last_sign_in_at || 0));
  res.json(list);
});

app.get("/api/admin/users/:id/photos", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({});
  const { data } = await db.from("user_profiles").select("selfie_front,selfie_right,selfie_left,selfie_at").eq("user_id", id).maybeSingle();
  if (!data) return res.json({ front: "", right: "", left: "", at: "" });
  audit(req, "view_photos", id);
  res.json({ front: data.selfie_front, right: data.selfie_right, left: data.selfie_left, at: data.selfie_at });
});

/* 資料庫即時狀態：直接抓取 Supabase /customer/v1/privileged/metrics 真實 Prometheus 指標 */
let lastCpuSample = null;
let cachedProm = { ts: 0, data: null };
async function fetchSupabaseRealMetrics() {
  const now = Date.now();
  if (cachedProm.data && now - cachedProm.ts < 2500) return cachedProm.data;
  const t0 = Date.now();
  const auth = "Basic " + Buffer.from("service_role:" + SUPABASE_SERVICE_ROLE_KEY).toString("base64");
  const resp = await fetch(`${SUPABASE_URL}/customer/v1/privileged/metrics`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(6000) });
  const latencyMs = Date.now() - t0;
  if (!resp.ok) throw new Error("Metrics HTTP " + resp.status);
  const text = await resp.text();
  const val = re => { const m = text.match(re); return m ? parseFloat(m[1]) : null; };
  const pct = (used, total) => total > 0 ? Math.round((used / total) * 100) : null;

  const memTotal = val(/node_memory_MemTotal_bytes\{[^}]*\}\s+([\d.e+-]+)/i) || 0;
  const memAvail = val(/node_memory_MemAvailable_bytes\{[^}]*\}\s+([\d.e+-]+)/i) || 0;
  const memUsed = Math.max(0, memTotal - memAvail);

  const diskSize = val(/node_filesystem_size_bytes\{[^}]*mountpoint="\/data"[^}]*\}\s+([\d.e+-]+)/i) || 0;
  const diskAvail = val(/node_filesystem_avail_bytes\{[^}]*mountpoint="\/data"[^}]*\}\s+([\d.e+-]+)/i) || 0;
  const diskUsed = Math.max(0, diskSize - diskAvail);

  let cpuIdle = 0, cpuTotal = 0, cm;
  const cpuRe = /node_cpu_seconds_total\{[^}]*mode="([^"]+)"\}\s+([\d.e+-]+)/g;
  while ((cm = cpuRe.exec(text)) !== null) { const v = parseFloat(cm[2]); cpuTotal += v; if (cm[1] === "idle") cpuIdle += v; }
  const load1 = val(/node_load1\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const load5 = val(/node_load5\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const load15 = val(/node_load15\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  let cpuPct = Math.max(1, Math.min(100, Math.round(load1 * 100)));
  if (lastCpuSample && cpuTotal > lastCpuSample.total) {
    const dTotal = cpuTotal - lastCpuSample.total, dIdle = cpuIdle - lastCpuSample.idle;
    if (dTotal > 0.2) cpuPct = Math.max(1, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  }
  if (cpuTotal > 0) lastCpuSample = { idle: cpuIdle, total: cpuTotal };

  const conns = Math.round(val(/pg_stat_database_num_backends\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0);
  const dbSizeMb = val(/pg_database_size_mb\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const walSizeMb = val(/pg_wal_size_mb\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const blksHit = val(/pg_stat_database_blks_hit_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const blksRead = val(/pg_stat_database_blks_read_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const xactCommit = Math.round(val(/pg_stat_database_xact_commit_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0);
  const xactRollback = Math.round(val(/pg_stat_database_xact_rollback_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0);
  const tupInserted = Math.round(val(/pg_stat_database_tup_inserted_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0);
  const tupUpdated = Math.round(val(/pg_stat_database_tup_updated_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0);
  const tupDeleted = Math.round(val(/pg_stat_database_tup_deleted_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0);
  const totalQueries = Math.round(val(/pg_stat_statements_calls_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? (xactCommit + xactRollback));
  const netRxBytes = val(/node_network_receive_bytes_total\{[^}]*device="ens5"[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const netTxBytes = val(/node_network_transmit_bytes_total\{[^}]*device="ens5"[^}]*\}\s+([\d.e+-]+)/i) ?? 0;

  const parsed = {
    ok: (val(/pg_up\{[^}]*\}\s+([\d.e+-]+)/i) ?? 1) === 1,
    latencyMs,
    cpuPct,
    diskPct: pct(diskUsed, diskSize) ?? 0,
    ramPct: pct(memUsed, memTotal) ?? 0,
    conns,
    maxConns: 60,
    memUsedMb: Math.round(memUsed / 1048576),
    memTotalMb: Math.round(memTotal / 1048576),
    diskUsedMb: Math.round(diskUsed / 1048576),
    diskTotalGb: (diskSize / 1073741824).toFixed(2),
    dbSizeMb: dbSizeMb.toFixed(2),
    walSizeMb: walSizeMb.toFixed(1),
    cacheHitPct: (blksHit + blksRead) > 0 ? ((blksHit / (blksHit + blksRead)) * 100).toFixed(2) : "100.00",
    xactCommit,
    xactRollback,
    tupInserted,
    tupUpdated,
    tupDeleted,
    totalQueries,
    load1: load1.toFixed(2),
    load5: load5.toFixed(2),
    load15: load15.toFixed(2),
    netRxMb: (netRxBytes / 1048576).toFixed(1),
    netTxMb: (netTxBytes / 1048576).toFixed(1),
  };
  cachedProm = { ts: now, data: parsed };
  return parsed;
}

// 一般使用者保守狀態：顯示國家、區域 ap-northeast-1 與即時 CPU / Disk / RAM / conns
app.get("/api/status", async (req, res) => {
  try {
    const m = await fetchSupabaseRealMetrics();
    res.json({
      ok: m.ok,
      dbName: "Primary Database",
      regionName: "Northeast Asia (Tokyo)",
      regionCode: "ap-northeast-1",
      instanceType: "t3.nano",
      cpuPct: m.cpuPct,
      diskPct: m.diskPct,
      ramPct: m.ramPct,
      conns: m.conns,
      maxConns: m.maxConns,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// 後台全開放狀態：回傳所有 Supabase 真實即時指標
app.get("/api/admin/status", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  try {
    const [m, proverbsRes, usersRes] = await Promise.all([
      fetchSupabaseRealMetrics(),
      db.from("proverbs").select("id", { count: "exact", head: true }),
      db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    const projectRef = (SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/) || [])[1] || "supabase";
    res.json({
      ...m, projectRef,
      dbName: "Primary Database", regionName: "Northeast Asia (Tokyo)", regionCode: "ap-northeast-1", instanceType: "t3.nano",
      proverbsCount: proverbsRes.count ?? 0,
      usersCount: usersRes.data?.users?.length ?? 0,
      nodeRssMb: Math.round(process.memoryUsage().rss / 1048576),
      checkedAt: new Date().toISOString(),
    });
  } catch { res.status(500).json({ ok: false, error: "status unavailable" }); }
});

app.delete("/api/admin/proverbs/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({});
  const { error } = await db.from("proverbs").delete().eq("id", id);
  audit(req, "delete_proverb", id);
  res.status(error ? 500 : 200).json({ ok: !error });
});

// 其他一切路徑（含原始碼、.env、node_modules）都不提供
app.use((req, res) => notFound(res));
app.use((err, req, res, next) => {   // 全域錯誤處理：不外洩堆疊與內部訊息
  if (err?.type === "entity.parse.failed" || err?.status === 400) return res.status(400).json({ error: "Bad request" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "內容過大" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});
if (require.main === module) app.listen(PORT, () => console.log(`Server: ${BASE_URL}`));
module.exports = app;   // Vercel 以此作為 serverless 進入點

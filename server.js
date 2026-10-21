const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET,
  ADMIN_EMAIL, ADMIN_PASSWORD_HASH, BASE_URL = "http://localhost:3000",
  ADMIN_ACCESS_KEY = "", PORT = 3000,
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
  });
  if (SECURE) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.json({ limit: "10kb" }));
// 所有寫入操作必須帶自訂標頭（簡易 CSRF 防護，搭配 SameSite cookie）
app.use((req, res, next) => {
  if (req.method !== "GET" && req.headers["x-requested-with"] !== "fetch") return notFound(res);
  next();
});

/* --- 前台 --- */
app.get("/", (req, res) => res.type("html").send(PAGES.index));

const pkceClient = store => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: {
  flowType: "pkce", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
  storage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
} });

app.get("/auth/google", async (req, res) => {
  if (limited("oauth:" + req.ip, 30, 600e3)) return res.status(429).send("Too many requests");
  const store = {};
  const { data, error } = await pkceClient(store).auth.signInWithOAuth({ provider: "google", options: {
    redirectTo: BASE_URL + "/auth/callback", skipBrowserRedirect: true,
    queryParams: { hd: "hlc.edu.tw", prompt: "select_account" },
  } });
  if (error) return res.redirect("/?e=oauth");
  setCookie(res, "kp", b64(JSON.stringify(store)), { maxAge: 600 });
  res.redirect(data.url);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error_description } = req.query;
  let store;
  try { store = JSON.parse(Buffer.from(cookies(req).kp || "", "base64url")); } catch { store = null; }
  clearCookie(res, "kp");
  if (error_description || !code || !store) return res.redirect("/?e=domain");
  const { data, error } = await pkceClient(store).auth.exchangeCodeForSession(String(code));
  if (error || !data?.user) return res.redirect("/?e=oauth");
  const u = data.user, email = (u.email || "").toLowerCase();
  if (!email.endsWith(SCHOOL)) {           // 非學校帳號：刪除剛建立的帳號並拒絕
    await db.auth.admin.deleteUser(u.id).catch(() => {});
    return res.redirect("/?e=domain");
  }
  setCookie(res, "ks", makeToken({ t: "u", id: u.id, email, name: u.user_metadata?.full_name || "" }, 8 * 3600));
  res.redirect("/");
});

app.get("/api/me", (req, res) => {
  const u = userOf(req);
  u ? res.json({ email: u.email, name: u.name }) : res.status(401).json({});
});
app.post("/api/logout", (req, res) => { clearCookie(res, "ks"); res.json({ ok: true }); });

app.post("/api/proverbs", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "請先登入" });
  if (limited("post:" + u.id, 10, 3600e3)) return res.status(429).json({ error: "投稿過於頻繁，請稍後再試" });
  const content = String(req.body?.content ?? "").trim(), author = String(req.body?.author ?? "").trim();
  if (!content || content.length > 100 || !author || author.length > 30) return res.status(400).json({ error: "內容格式不正確" });
  const { error } = await db.from("proverbs").insert({ user_id: u.id, user_email: u.email, user_name: u.name || null, content, author });
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

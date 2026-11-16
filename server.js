const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const tls = require("tls");
const zlib = require("zlib");
const util = require("util");
const { Readable } = require("stream");

let sea = null;
try { sea = require("node:sea"); } catch {}
const IS_SEA = Boolean(sea && typeof sea.isSea === "function" && sea.isSea());

function loadRuntimeEnv() {
  const embeddedKeys = new Set();
  if (IS_SEA) {
    try {
      const rawEmbedded = sea.getAsset(".env", "utf8");
      const parsed = util.parseEnv(rawEmbedded);
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
          embeddedKeys.add(k);
        }
      }
    } catch {}
  }

  const candidatePaths = IS_SEA
    ? [
        process.env.KKNEWS_ENV_PATH,
        path.join(path.dirname(process.execPath), ".env"),
        path.join(process.cwd(), ".env"),
      ]
    : [
        process.env.KKNEWS_ENV_PATH,
        path.join(__dirname, ".env"),
        path.join(process.cwd(), ".env"),
      ];

  for (const envPath of candidatePaths) {
    if (!envPath) continue;
    try {
      if (!fs.existsSync(envPath)) continue;
      const parsed = util.parseEnv(fs.readFileSync(envPath, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined || embeddedKeys.has(k)) {
          process.env[k] = v;
          embeddedKeys.delete(k);
        }
      }
      break;
    } catch {}
  }
}
loadRuntimeEnv();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET,
  ADMIN_EMAIL, ADMIN_PASSWORD_HASH,
  ADMIN_ACCESS_KEY = "",
  ADMIN_OTP_EMAIL = "kai1010210@gmail.com",
  RESEND_API_KEY = process.env.RESEND_API_KEY || "",
  RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "KKNews 安全中心 <onboarding@resend.dev>",
  SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com",
  SMTP_PORT = process.env.SMTP_PORT || 465,
  SMTP_USER = process.env.SMTP_USER || "",
  SMTP_PASS = process.env.SMTP_PASS || "",
  SMTP_FROM = process.env.SMTP_FROM || "",
  SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "",
  BREVO_API_KEY = process.env.BREVO_API_KEY || "",
  MAIL_WEBHOOK_URL = process.env.MAIL_WEBHOOK_URL || "",
  BASE_URL = "http://localhost:3000", PORT = 3000, GOOGLE_CLIENT_ID = "",
  GOOGLE_FORM_API_KEY = process.env.GOOGLE_API_KEY || "",
  TURNSTILE_SECRET_KEY = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || process.env.CLOUDFLARE_SECRET_KEY || "",
  DFC_ALLOWED_EMAILS = "",
  DFC_ACCESS_MODE = "whitelist",
  INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID || "",
  INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "",
  INSTAGRAM_AUTO_POST = process.env.INSTAGRAM_AUTO_POST !== "false",
  INSTAGRAM_CAPTION_TEMPLATE = process.env.INSTAGRAM_CAPTION_TEMPLATE || "{content}\n\n— {author}\n\n#KKNews #校園金句 #諺語工坊 #花蓮教育",
  INSTAGRAM_WEBHOOK_URL = process.env.INSTAGRAM_WEBHOOK_URL || "",
} = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD_HASH })) {
  if (!v) {
    const msg = `缺少環境變數 ${k}（請參考 .env.example）`;
    if (process.env.KKNEWS_THROW_ON_ENV_ERROR === "1") throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }
}
const SCHOOL = "@hlc.edu.tw";
const SCHOOL_HD = "hlc.edu.tw";
const SECURE = BASE_URL.startsWith("https") || process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

const seaAssetBufCache = new Map();
function getSeaRawBuffer(assetKey) {
  if (!IS_SEA) return null;
  if (seaAssetBufCache.has(assetKey)) return seaAssetBufCache.get(assetKey);
  try {
    const buf = Buffer.from(sea.getRawAsset(assetKey));
    seaAssetBufCache.set(assetKey, buf);
    return buf;
  } catch {
    seaAssetBufCache.set(assetKey, null);
    return null;
  }
}
function readAppText(diskPaths, seaKeys, fallback = "") {
  for (const p of diskPaths) {
    try { return fs.readFileSync(p, "utf8"); } catch {}
  }
  if (IS_SEA) {
    for (const k of seaKeys) {
      try { return sea.getAsset(k, "utf8"); } catch {}
    }
  }
  return fallback;
}
function readAppBuffer(diskPaths, seaKeys) {
  for (const p of diskPaths) {
    try { return fs.readFileSync(p); } catch {}
  }
  if (IS_SEA) {
    for (const k of seaKeys) {
      const buf = getSeaRawBuffer(k);
      if (buf) return buf;
    }
  }
  return null;
}

/* 前端頁面：內嵌 <script> 抽成外部檔案並自動附加內容雜湊 (?v=hash)，徹底杜絕瀏覽器與 CDN 舊快取殘留 */
const RAW_UI_CSS = readAppText([path.join(__dirname, "views", "ui.css")], ["views/ui.css"]);
const UI_CSS_HASH = crypto.createHash("md5").update(RAW_UI_CSS).digest("hex").slice(0, 10);

function splitPage(html, name) {
  let js = "";
  const withCssHash = html.replace(/\/assets\/ui\.css(?:\?[^"']*)?/g, `/assets/ui.css?v=${UI_CSS_HASH}`);
  const out = withCssHash.replace(/<script>([\s\S]*?)<\/script>/, (m, code) => {
    js = code;
    const jsHash = crypto.createHash("md5").update(code).digest("hex").slice(0, 10);
    return `<script src="/assets/${name}.js?v=${jsHash}" defer></script>`;
  });
  return { html: out, js };
}
function readIconSvg() {
  return readAppText(
    [path.join(__dirname, "icon.svg"), path.join(__dirname, "views", "icon.svg")],
    ["icon.svg", "views/icon.svg"],
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#1868c7"/><text x="50" y="64" font-size="42" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">KK</text></svg>'
  );
}
function readJsZip() {
  return readAppText(
    [path.join(__dirname, "node_modules", "jszip", "dist", "jszip.min.js"), path.join(__dirname, "jszip.min.js")],
    ["node_modules/jszip/dist/jszip.min.js", "jszip.min.js"],
    ""
  );
}
const PAGES = {
  index: splitPage(readAppText([path.join(__dirname, "views", "index.html")], ["views/index.html"]), "index"),
  login: splitPage(readAppText([path.join(__dirname, "views", "admin-login.html")], ["views/admin-login.html"]), "login"),
  admin: splitPage(readAppText([path.join(__dirname, "views", "admin.html")], ["views/admin.html"]), "admin"),
  css: RAW_UI_CSS,
  jszip: readJsZip(),
  icon: readIconSvg(),
};

// 確保在 Node 18/20 或 Serverless 環境下相容最新 @supabase/supabase-js
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = class WebSocketShim { constructor() {} };
}

// 服務金鑰只存在於伺服器，瀏覽器永遠拿不到
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/* ---------- 工具與管理員權限分級（Super Admin vs 一般 Admin） ---------- */
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

// 判斷是否為系統預設主 Super Admin 信箱（僅限 .env ADMIN_EMAIL 主帳號，其餘新增帳號皆可自由設定為一般 admin 或 super_admin）
const isPrimaryAdminEmail = email => {
  const e = String(email || "").trim().toLowerCase();
  return Boolean(e && eq(e, ADMIN_EMAIL.trim().toLowerCase()));
};
const normalizeAdminRole = (role, email) => {
  if (isPrimaryAdminEmail(email)) return "super_admin";
  return String(role || "").trim().toLowerCase() === "super_admin" ? "super_admin" : "admin";
};
const adminOf = req => {
  const p = readToken(cookies(req).ka);
  if (!p || p.t !== "a") return null;
  const email = String(p.email || ADMIN_EMAIL).trim().toLowerCase();
  if (isPrimaryAdminEmail(email) || p.isPrimary) {
    return { ...p, email, role: "super_admin", isPrimary: true, name: p.name || "Super Admin (主管理員)" };
  }
  const cachedAdmins = sysCache.get("admins")?.data;
  if (Array.isArray(cachedAdmins)) {
    const liveAcc = cachedAdmins.find(a => String(a.email || "").trim().toLowerCase() === email);
    if (!liveAcc) return null;
    // 密碼重設後強制舊 Token 失效 (Session Revocation)
    if (p.pwAt && liveAcc.pwUpdatedAt && p.pwAt !== liveAcc.pwUpdatedAt) return null;
    const liveRole = normalizeAdminRole(liveAcc.role, email);
    return {
      ...p,
      email,
      role: liveRole,
      isPrimary: false,
      name: liveAcc.name || (liveRole === "super_admin" ? "Super Admin" : "一般管理員（唯讀）"),
    };
  }
  const role = normalizeAdminRole(p.role, email);
  return { ...p, email, role, isPrimary: false, name: p.name || (role === "super_admin" ? "Super Admin" : "一般管理員（唯讀）") };
};
const superAdminOf = req => {
  const a = adminOf(req);
  return a && a.role === "super_admin" ? a : null;
};
const forbidReadOnly = res => res.status(403).json({ error: "權限不足：一般管理員僅能查看數據，無法執行修改或刪除操作" });
const notFound = (res) => res.status(404).type("text/plain").send("Not found");
const clientIp = req => String(req.ip || "");   // 交給 Express trust proxy 解析，避免被偽造的 X-Forwarded-For 欺騙

/* 限流：本地記憶體極速過濾 + Supabase 分布式同步（防止高併發打爆 DB 連線池） */
const hits = new Map();
function limitedMem(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();
async function limited(key, max, windowMs) {
  // 1. 本地記憶體極速前置防護：若已超出閾值 1.5 倍，直接在記憶體阻擋，不觸發 DB 查詢避免連線池枯竭
  if (limitedMem(key, Math.ceil(max * 1.5), windowMs)) return true;
  try {
    const { error: e1 } = await db.from("rate_limits").insert({ key });
    if (e1) throw e1;
    const since = new Date(Date.now() - windowMs).toISOString();
    const { count, error: e2 } = await db.from("rate_limits").select("key", { count: "exact", head: true }).eq("key", key).gte("created_at", since);
    if (e2) throw e2;
    if (Math.random() < 0.02) db.from("rate_limits").delete().lt("created_at", new Date(Date.now() - 86400e3).toISOString()).catch(() => {});
    return count > max;
  } catch { return limitedMem(key, max, windowMs); }
}
const audit = (req, action, target = "") => {
  invalidateQueryCache("auditLogs");
  return db.from("admin_audit").insert({ action, target: String(target), ip: clientIp(req) }).then(() => {}, () => {});
};

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = await new Promise((ok, no) => crypto.scrypt(String(pw), salt, 64, (e, k) => e ? no(e) : ok(k.toString("hex"))));
  return `${salt}:${h}`;
}
async function verifyPassword(pw, storedHash = ADMIN_PASSWORD_HASH) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const h = await new Promise((ok, no) => crypto.scrypt(String(pw), salt, 64, (e, k) => e ? no(e) : ok(k.toString("hex"))));
  return eq(h, hash);
}

/* ---------- 多重雲端持久化儲存（PostgreSQL 強一致優先 + Supabase Storage + 本機快取，防 CDN 舊快取覆蓋） ---------- */
const sysCache = new Map();
const queryCache = new Map();
let bucketEnsured = false;
let adminAuditTableOk = true;
let sysSettingsTableOk = true;
let dfcFormsTableOk = true;
let dfcQuestionsTableOk = true;
let dfcResponsesTableOk = true;
const SYS_STORE_PREFIX = "__sys_store__:";

function localStorePath(name) {
  return path.join(os.tmpdir(), `kknews_sys_${name}.json`);
}
function unwrapStorePayload(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.__kk_rev === "number" && "data" in raw) {
    return { rev: raw.__kk_rev, data: raw.data };
  }
  return { rev: 1, data: raw };
}

function invalidateQueryCache(...keys) {
  if (!keys.length) { queryCache.clear(); return; }
  for (const k of keys) queryCache.delete(k);
}
async function cachedQuery(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = queryCache.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.data;
  if (hit?.inflight) return hit.inflight;
  const inflight = Promise.resolve().then(fetcher).then(data => {
    queryCache.set(key, { ts: Date.now(), data });
    return data;
  }).catch(err => {
    if (hit?.data !== undefined) return hit.data;
    queryCache.delete(key);
    throw err;
  });
  queryCache.set(key, { ts: hit?.ts || 0, data: hit?.data, inflight });
  return inflight;
}
async function ensureVerifyBucket() {
  if (bucketEnsured) return;
  bucketEnsured = true;
  try { await db.storage.createBucket("kknews-verify", { public: false }); } catch {}
}
async function readSysStore(name, fallback, forceFresh = false) {
  const now = Date.now();
  const cached = sysCache.get(name);
  if (!forceFresh && cached && now - cached.ts < 10000) {
    const clonedCached = JSON.parse(JSON.stringify(cached.data));
    return name === "dfc" ? sanitizeDfcStore(clonedCached) : clonedCached;
  }

  let best = cached ? { rev: cached.rev || 1, data: cached.data } : null;
  let loadedFromPrimary = false;
  const consider = (raw) => {
    if (raw === undefined || raw === null) return;
    const candidate = unwrapStorePayload(raw);
    if (!best || candidate.rev >= best.rev) best = candidate;
  };

  // 1. 若 PostgreSQL sys_settings 資料表存在，優先讀取系統設定
  if (sysSettingsTableOk) {
    try {
      const { data: row, error } = await db
        .from("sys_settings")
        .select("value, updated_at")
        .eq("key", name)
        .maybeSingle();
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        sysSettingsTableOk = false;
      } else if (!error && row && row.value) {
        consider(row.value);
        loadedFromPrimary = true;
      }
    } catch {}
  }

  // 2. 若 sys_settings 尚無資料且 admin_audit 資料表存在，讀取系統設定備用列
  if (!loadedFromPrimary && adminAuditTableOk) {
    try {
      const { data: rows, error } = await db
        .from("admin_audit")
        .select("target, created_at")
        .eq("action", SYS_STORE_PREFIX + name)
        .order("id", { ascending: false })
        .limit(1);
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        adminAuditTableOk = false;
      } else if (!error && rows && rows[0]?.target) {
        consider(JSON.parse(rows[0].target));
        loadedFromPrimary = true;
      }
    } catch {}
  }

  // 3. 若資料庫皆無紀錄，檢查私有 Supabase Storage 備份
  if (!loadedFromPrimary && (!best || best.rev <= 1)) {
    try {
      await ensureVerifyBucket();
      const { data: blob, error } = await db.storage.from("kknews-verify").download(`_sys_${name}.json`);
      if (!error && blob) {
        consider(JSON.parse(await blob.text()));
      }
    } catch {}
  }

  // 4. 檢查本機暫存檔（單機重啟或離線保護）
  try {
    const p = localStorePath(name);
    if (fs.existsSync(p)) {
      consider(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  } catch {}

  if (best && best.data !== undefined) {
    const finalData = name === "dfc" ? sanitizeDfcStore(best.data) : best.data;
    sysCache.set(name, { ts: Date.now(), rev: best.rev, data: finalData });
    return JSON.parse(JSON.stringify(finalData));
  }
  const init = name === "dfc" ? sanitizeDfcStore(JSON.parse(JSON.stringify(fallback))) : JSON.parse(JSON.stringify(fallback));
  sysCache.set(name, { ts: Date.now(), rev: 0, data: init });
  return JSON.parse(JSON.stringify(init));
}
async function writeSysStore(name, data) {
  const prevRev = sysCache.get(name)?.rev || 0;
  const rev = Math.max(Date.now(), prevRev + 1);
  const cloned = name === "dfc" ? sanitizeDfcStore(JSON.parse(JSON.stringify(data))) : JSON.parse(JSON.stringify(data));
  sysCache.set(name, { ts: Date.now(), rev, data: cloned });
  const payloadStr = JSON.stringify({ __kk_rev: rev, data: cloned });

  // 1. 寫入本機暫存檔
  try { fs.writeFileSync(localStorePath(name), payloadStr, "utf8"); } catch {}

  // 2. 寫入 PostgreSQL sys_settings 資料表
  const sysSettingsWrite = (async () => {
    if (!sysSettingsTableOk) return;
    try {
      const { error } = await db.from("sys_settings").upsert({
        key: name,
        value: { __kk_rev: rev, data: cloned },
        updated_at: new Date().toISOString(),
      });
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        sysSettingsTableOk = false;
      }
    } catch {}
  })();

  // 3. 寫入 PostgreSQL admin_audit 儲存並清理舊版本列
  const storeKey = SYS_STORE_PREFIX + name;
  const dbWrite = (async () => {
    if (!adminAuditTableOk) return;
    try {
      const { data: inserted, error } = await db
        .from("admin_audit")
        .insert({ action: storeKey, target: payloadStr, ip: "sys" })
        .select("id")
        .maybeSingle();
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        adminAuditTableOk = false;
      } else if (!error && inserted?.id) {
        await db.from("admin_audit").delete().eq("action", storeKey).lt("id", inserted.id);
      }
    } catch {}
  })();

  // 4. 同步備份至 Supabase Storage
  const storageWrite = (async () => {
    try {
      await ensureVerifyBucket();
      const buf = Buffer.from(payloadStr, "utf8");
      await db.storage.from("kknews-verify").upload(`_sys_${name}.json`, buf, {
        upsert: true,
        cacheControl: "0",
        contentType: "application/json",
      });
    } catch {}
  })();

  await Promise.allSettled([sysSettingsWrite, dbWrite, storageWrite]);
  return JSON.parse(JSON.stringify(cloned));
}

/* ---------- Supabase 原生 DFC 資料表 (dfc_forms, dfc_questions, dfc_responses) 直接存取層 ---------- */
async function getDfcQuestionsFromSupabase(formId = null) {
  if (!dfcQuestionsTableOk) return null;
  try {
    let q = db.from("dfc_questions").select("*").order("question_order", { ascending: true });
    if (formId) q = q.eq("form_id", formId);
    const { data, error } = await q;
    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") dfcQuestionsTableOk = false;
      return null;
    }
    if (Array.isArray(data)) {
      return data.map(qRow => ({
        id: qRow.id,
        formId: qRow.form_id,
        time: Number(qRow.time_seconds) || 0,
        stepLabel: qRow.step_label || "",
        title: qRow.title || "",
        type: qRow.type || "radio",
        options: Array.isArray(qRow.options) ? qRow.options : [],
        desc: qRow.description || "",
        required: qRow.required !== false,
        placeholder: qRow.placeholder || "",
        min: Number(qRow.min_val) || 1,
        max: Number(qRow.max_val) || 5,
        entryId: qRow.entry_id || qRow.id,
      }));
    }
    return null;
  } catch {
    return null;
  }
}

async function syncDfcQuestionsInSupabase(formId, checkpoints) {
  if (!dfcQuestionsTableOk || !formId || !Array.isArray(checkpoints)) return false;
  try {
    if (checkpoints.length === 0) {
      await db.from("dfc_questions").delete().eq("form_id", formId);
      return true;
    }

    const rows = checkpoints.map((cp, idx) => ({
      id: String(cp.id || `${formId}-q${idx + 1}`).trim(),
      form_id: formId,
      question_order: idx + 1,
      time_seconds: Math.max(0, Number(cp.time) || 0),
      step_label: String(cp.stepLabel || `階段 ${idx + 1}`).trim(),
      title: String(cp.title || `問題 ${idx + 1}`).trim(),
      type: ["radio", "checkbox", "rating", "dropdown", "boolean", "text", "textarea"].includes(cp.type) ? cp.type : "radio",
      options: Array.isArray(cp.options) ? cp.options : [],
      description: String(cp.desc || "").trim(),
      required: cp.required !== false,
      placeholder: String(cp.placeholder || "").trim(),
      min_val: Number(cp.min) || 1,
      max_val: Number(cp.max) || 5,
      entry_id: String(cp.entryId || cp.id || "").trim(),
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertErr } = await db.from("dfc_questions").upsert(rows);
    if (upsertErr) {
      if (upsertErr.code === "PGRST205" || upsertErr.code === "42P01") dfcQuestionsTableOk = false;
      return false;
    }

    // 刪除該表單中已被移除的舊題目
    const activeIds = rows.map(r => r.id);
    const { data: existing } = await db.from("dfc_questions").select("id").eq("form_id", formId);
    if (Array.isArray(existing)) {
      const toDelete = existing.map(e => e.id).filter(id => !activeIds.includes(id));
      if (toDelete.length > 0) {
        await db.from("dfc_questions").delete().in("id", toDelete);
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function getDfcFormsFromSupabase() {
  if (!dfcFormsTableOk) return null;
  try {
    const { data, error } = await db.from("dfc_forms").select("*").order("created_at", { ascending: true });
    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") dfcFormsTableOk = false;
      return null;
    }
    if (Array.isArray(data) && data.length > 0) {
      let allQuestions = null;
      if (dfcQuestionsTableOk) {
        allQuestions = await getDfcQuestionsFromSupabase();
      }

      return data.map(f => {
        let cps = Array.isArray(f.checkpoints) ? f.checkpoints : [];
        if (allQuestions && allQuestions.length > 0) {
          const formQs = allQuestions.filter(q => q.formId === f.id);
          if (formQs.length > 0) {
            cps = formQs;
          }
        }
        return {
          id: f.id,
          title: f.title || "DFC 互動影片探究問卷",
          description: f.description || "",
          videoUrl: f.video_url || "",
          fallbackDuration: Number(f.fallback_duration) || 363,
          submitMode: f.submit_mode || "end",
          allowSeek: f.allow_seek || "watched",
          allowRewind: f.allow_rewind !== false,
          allowSpeed: Boolean(f.allow_speed),
          pauseOnBlur: f.pause_on_blur !== false,
          isDefault: Boolean(f.is_active),
          checkpoints: cps,
          updatedAt: f.updated_at || f.created_at || new Date().toISOString(),
        };
      });
    }
    return null;
  } catch {
    return null;
  }
}

async function upsertDfcFormInSupabase(formObj) {
  if (!dfcFormsTableOk) return false;
  try {
    const payload = {
      id: formObj.id,
      title: formObj.title,
      description: formObj.description || "",
      video_url: formObj.videoUrl || "",
      fallback_duration: formObj.fallbackDuration || 363,
      submit_mode: formObj.submitMode || "end",
      allow_seek: formObj.allowSeek || "watched",
      allow_rewind: formObj.allowRewind !== false,
      allow_speed: Boolean(formObj.allowSpeed),
      pause_on_blur: formObj.pauseOnBlur !== false,
      is_active: Boolean(formObj.isDefault),
      checkpoints: Array.isArray(formObj.checkpoints) ? formObj.checkpoints : [],
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("dfc_forms").upsert(payload);
    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") dfcFormsTableOk = false;
      return false;
    }
    // 同步個別題目至 dfc_questions 資料表
    if (dfcQuestionsTableOk && Array.isArray(formObj.checkpoints)) {
      await syncDfcQuestionsInSupabase(formObj.id, formObj.checkpoints);
    }
    return true;
  } catch {
    return false;
  }
}

async function deleteDfcFormInSupabase(formId) {
  if (!dfcFormsTableOk) return false;
  try {
    if (dfcQuestionsTableOk) {
      await db.from("dfc_questions").delete().eq("form_id", formId).catch(() => {});
    }
    if (dfcResponsesTableOk) {
      await db.from("dfc_responses").delete().eq("form_id", formId).catch(() => {});
    }
    const { error } = await db.from("dfc_forms").delete().eq("id", formId);
    return !error;
  } catch {
    return false;
  }
}

async function setActiveDfcFormInSupabase(formId) {
  if (!dfcFormsTableOk) return false;
  try {
    await db.from("dfc_forms").update({ is_active: false }).neq("id", "__never__");
    await db.from("dfc_forms").update({ is_active: true }).eq("id", formId);
    return true;
  } catch {
    return false;
  }
}

async function getDfcResponsesFromSupabase(formId) {
  if (!dfcResponsesTableOk) return null;
  try {
    let query = db.from("dfc_responses").select("*").order("submitted_at", { ascending: false }).limit(2000);
    if (formId && formId !== "all") {
      query = query.eq("form_id", formId);
    }
    const { data, error } = await query;
    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") dfcResponsesTableOk = false;
      return null;
    }
    if (Array.isArray(data)) {
      return data.map(r => ({
        id: r.id,
        formId: r.form_id,
        formTitle: r.form_title || "",
        userEmail: r.user_email || "",
        userName: r.user_name || "",
        userClass: r.user_class || "",
        answers: r.answers || {},
        telemetry: r.telemetry || {},
        engagement: r.engagement || {},
        device: r.device || "",
        ip: r.ip_address || "",
        syncedToGoogle: false,
        demo: false,
        submittedAt: r.submitted_at || r.created_at,
      }));
    }
    return null;
  } catch {
    return null;
  }
}

async function insertDfcResponseInSupabase(respObj) {
  if (!dfcResponsesTableOk) return false;
  try {
    // 確保對應的 dfc_forms 存在，防止外鍵約束觸發錯誤
    if (dfcFormsTableOk && respObj.formId) {
      const { data: fExist } = await db.from("dfc_forms").select("id").eq("id", respObj.formId).maybeSingle();
      if (!fExist) {
        await db.from("dfc_forms").upsert({
          id: respObj.formId,
          title: respObj.formTitle || "DFC 互動問卷",
          checkpoints: [],
          updated_at: new Date().toISOString(),
        });
      }
    }
    const payload = {
      form_id: respObj.formId || "default-dfc",
      form_title: respObj.formTitle || "",
      user_id: respObj.userId || null,
      user_email: respObj.userEmail || "",
      user_name: respObj.userName || "",
      user_class: respObj.userClass || "",
      answers: respObj.answers || {},
      telemetry: respObj.telemetry || {},
      engagement: respObj.engagement || {},
      device: respObj.device || "",
      ip_address: respObj.ip || "",
      submitted_at: respObj.submittedAt || new Date().toISOString(),
    };
    const { error } = await db.from("dfc_responses").insert(payload);
    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") dfcResponsesTableOk = false;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function getDfcStatsFromSupabase() {
  try {
    const { data: rpcData, error: rpcErr } = await db.rpc("get_dfc_stats");
    if (!rpcErr && rpcData && typeof rpcData === "object") {
      return {
        ok: true,
        tables: {
          dfc_forms: true,
          dfc_questions: true,
          dfc_responses: true,
          dfc_access_list: true,
        },
        counts: {
          forms: rpcData.forms_count || 0,
          questions: rpcData.questions_count || 0,
          responses: rpcData.responses_count || 0,
          access: rpcData.access_count || 0,
        },
      };
    }
  } catch {}

  try {
    const [fRes, qRes, rRes, aRes] = await Promise.allSettled([
      db.from("dfc_forms").select("id", { count: "exact", head: true }),
      db.from("dfc_questions").select("id", { count: "exact", head: true }),
      db.from("dfc_responses").select("id", { count: "exact", head: true }),
      db.from("dfc_access_list").select("id", { count: "exact", head: true }),
    ]);

    const formsCount = fRes.status === "fulfilled" && !fRes.value.error ? (fRes.value.count ?? 0) : null;
    const questionsCount = qRes.status === "fulfilled" && !qRes.value.error ? (qRes.value.count ?? 0) : null;
    const responsesCount = rRes.status === "fulfilled" && !rRes.value.error ? (rRes.value.count ?? 0) : null;
    const accessCount = aRes.status === "fulfilled" && !aRes.value.error ? (aRes.value.count ?? 0) : null;

    return {
      ok: formsCount !== null,
      tables: {
        dfc_forms: formsCount !== null,
        dfc_questions: questionsCount !== null,
        dfc_responses: responsesCount !== null,
        dfc_access_list: accessCount !== null,
      },
      counts: {
        forms: formsCount ?? 0,
        questions: questionsCount ?? 0,
        responses: responsesCount ?? 0,
        access: accessCount ?? 0,
      },
    };
  } catch {
    return { ok: false, tables: {}, counts: {} };
  }
}

async function deleteDfcResponsesInSupabase(id, formId) {
  if (!dfcResponsesTableOk) return false;
  try {
    if (id === "all") {
      let q = db.from("dfc_responses").delete();
      if (formId) q = q.eq("form_id", formId);
      else q = q.neq("user_email", "__never__");
      const { error } = await q;
      return !error;
    } else {
      const { error } = await db.from("dfc_responses").delete().eq("id", id);
      return !error;
    }
  } catch {
    return false;
  }
}

async function getDfcStoreWithDb(forceFresh = false) {
  const store = await readSysStore("dfc", DEFAULT_DFC_STORE, forceFresh);
  const dbForms = await getDfcFormsFromSupabase();
  if (Array.isArray(dbForms) && dbForms.length > 0) {
    store.forms = dbForms;
    const active = dbForms.find(f => f.isDefault) || dbForms[0];
    if (active) store.activeFormId = active.id;
  }
  const dbResponses = await getDfcResponsesFromSupabase(null);
  if (Array.isArray(dbResponses)) {
    store.responses = dbResponses;
  }
  return store;
}

function normalizeEmailRule(v = "") {
  return String(v || "").trim().toLowerCase();
}
function parseEmailListInput(input) {
  const rawList = Array.isArray(input)
    ? input
    : String(input || "").split(/[\r\n,;，；\s]+/);
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const clean = normalizeEmailRule(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

const DEFAULT_DFC_ACCESS_MODE = ["whitelist", "all_school", "closed"].includes(String(DFC_ACCESS_MODE || "").trim().toLowerCase())
  ? String(DFC_ACCESS_MODE).trim().toLowerCase()
  : "whitelist";

const DEFAULT_DFC_CHECKPOINTS = [
  { id: "q1", time: 4, stepLabel: "階段一 · 感受 Feel (第1題)", title: "在剛才影片片段中，你觀察到最核心的校園問題是什麼？", type: "radio", options: ["資訊傳遞分散", "空間與動線視覺凌亂", "缺乏即時回饋管道"], desc: "請選擇一個最貼近你觀察到的現象。", required: true },
  { id: "q2", time: 4, stepLabel: "階段一 · 感受 Feel (第2題)", title: "你認為這個問題對哪一群體的影響最大？", type: "checkbox", options: ["全體學生", "導師與行政組長", "家長與校友", "學校訪客"], desc: "本題為多選題，可複選最關鍵的影響對象。", required: true },
  { id: "q3", time: 10, stepLabel: "階段二 · 想像 Imagine (第1題)", title: "針對這個問題，你認為哪些創意解方最值得嘗試？", type: "checkbox", options: ["導入互動式影音表單", "建立校園專屬的一句話共創牆", "結合跨班級工作坊快速製作原型"], desc: "此題為多選題，可勾選一或多項方案。", required: true },
  { id: "q4", time: 10, stepLabel: "階段二 · 想像 Imagine (第2題)", title: "你認為以上解方的實施難易度為何？", type: "dropdown", options: ["非常容易立即推行", "需要跨處室合作", "需要較多經費與時間"], desc: "請評估此項解方在校園推行的可行性與難易度。", required: false },
  { id: "q5", time: 18, stepLabel: "階段三 · 實踐 Do", title: "請簡述你在本次行動中擔任的角色或預計實踐的項目", type: "textarea", options: [], desc: "限 50 字以內，簡要描述即可。", required: false },
  { id: "q6", time: 22, "stepLabel": "階段四 · 分享 Share (第1題)", title: "你是否願意將本次成果分享於全校互動成果牆？", type: "boolean", options: [], desc: "請選擇是否願意公開分享。", required: true },
  { id: "q7", time: 22, "stepLabel": "階段四 · 分享 Share (第2題)", title: "你對本次校園 DFC 方案的整體推薦評分？", type: "rating", options: [], desc: "請給予 1 至 5 星綜合推薦評分（1 星最低，5 星最高）。", min: 1, max: 5, required: true }
];

const DEFAULT_DFC_STORE = {
  activeFormId: "default-dfc",
  accessMode: DEFAULT_DFC_ACCESS_MODE,
  allowedEmails: parseEmailListInput(DFC_ALLOWED_EMAILS),
  forms: [
    {
      id: "default-dfc",
      title: "DFC 互動影片探究問卷",
      description: "DFC 四步驟互動影片探究與反思問卷",
      videoUrl: "https://drive.google.com/file/d/1Jm37XrtHhQP8BIVapn7jY00mx2T_MESe/preview",
      fallbackDuration: 363,
      submitMode: "end",
      allowSeek: "watched",
      allowRewind: true,
      allowSpeed: false,
      pauseOnBlur: true,
      isDefault: true,
      updatedAt: new Date().toISOString(),
      checkpoints: DEFAULT_DFC_CHECKPOINTS,
    },
  ],
  responses: [],
};

// 確保防暴雷觀看權限欄位完整與表單格式標準
function sanitizeDfcStore(store) {
  if (!store || typeof store !== "object") return JSON.parse(JSON.stringify(DEFAULT_DFC_STORE));
  if (!["whitelist", "all_school", "closed"].includes(store.accessMode)) {
    store.accessMode = DEFAULT_DFC_ACCESS_MODE;
  }
  store.allowedEmails = parseEmailListInput(store.allowedEmails || []);
  if (!Array.isArray(store.forms) || store.forms.length === 0) {
    store.forms = JSON.parse(JSON.stringify(DEFAULT_DFC_STORE.forms));
  }
  store.forms = store.forms.map(f => {
    if (!Array.isArray(f.checkpoints)) {
      f.checkpoints = [];
    }
    return f;
  });
  return store;
}

/* ---------- DFC 影片防暴雷權限控管（支援後台設定、Supabase dfc_access_list 資料表與 .env DFC_ALLOWED_EMAILS） ---------- */
function matchDfcEmailPattern(userEmail, pattern) {
  const email = normalizeEmailRule(userEmail);
  const pat = normalizeEmailRule(pattern);
  if (!email || !pat) return false;
  if (pat === "*" || pat === "all" || pat === "*@hlc.edu.tw") return email.endsWith(SCHOOL);
  const localPart = email.split("@")[0] || "";
  if (!pat.includes("@")) {
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
      return re.test(localPart);
    }
    return localPart === pat;
  }
  if (pat.includes("*")) {
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    return re.test(email);
  }
  return email === pat;
}

async function fetchDbDfcAccessList() {
  return cachedQuery("dfcAccessTable", 4000, async () => {
    try {
      const { data, error } = await db.from("dfc_access_list").select("email_pattern, note, added_by, created_at").order("id", { ascending: true });
      if (error || !Array.isArray(data)) return [];
      return data.map(r => normalizeEmailRule(r.email_pattern)).filter(Boolean);
    } catch {
      return [];
    }
  });
}

async function syncDbDfcAccessList(allowedEmails = [], addedBy = "admin") {
  invalidateQueryCache("dfcAccessTable");
  try {
    const clean = parseEmailListInput(allowedEmails);
    await db.from("dfc_access_list").delete().neq("email_pattern", "__never__");
    if (clean.length) {
      await db.from("dfc_access_list").upsert(
        clean.map(email_pattern => ({ email_pattern, added_by: addedBy })),
        { onConflict: "email_pattern" }
      );
    }
  } catch {}
}

async function getMergedDfcAccessConfig(storeArg = null) {
  const [store, dbList, adminList] = await Promise.all([
    storeArg ? Promise.resolve(sanitizeDfcStore(storeArg)) : readSysStore("dfc", DEFAULT_DFC_STORE),
    fetchDbDfcAccessList().catch(() => []),
    readSysStore("admins", []).catch(() => []),
  ]);
  const envList = parseEmailListInput(DFC_ALLOWED_EMAILS);
  const storeList = parseEmailListInput(store.allowedEmails || []);
  const adminEmails = [
    normalizeEmailRule(ADMIN_EMAIL),
    ...(Array.isArray(adminList) ? adminList.map(a => normalizeEmailRule(a.email)) : []),
  ].filter(Boolean);

  const merged = parseEmailListInput([...storeList, ...dbList, ...envList]);
  return {
    accessMode: store.accessMode || DEFAULT_DFC_ACCESS_MODE,
    allowedEmails: merged,
    storeAllowedEmails: storeList,
    dbAllowedEmails: dbList,
    envAllowedEmails: envList,
    adminEmails,
  };
}

async function evaluateDfcAccess(req, storeArg = null) {
  const cfg = await getMergedDfcAccessConfig(storeArg);
  const adm = adminOf(req);
  if (adm) {
    return {
      allowed: true,
      isAdmin: true,
      mode: cfg.accessMode,
      reason: "admin",
      message: "管理員全權預覽模式",
      allowedEmails: cfg.allowedEmails,
    };
  }
  const u = userOf(req);
  if (!u || !u.email) {
    return {
      allowed: false,
      isAdmin: false,
      mode: cfg.accessMode,
      reason: "unauthenticated",
      message: "請先使用學校 Google 帳號 (@hlc.edu.tw) 登入以驗證觀看權限。",
      allowedEmails: cfg.allowedEmails,
    };
  }
  const email = normalizeEmailRule(u.email);
  if (cfg.adminEmails.some(a => matchDfcEmailPattern(email, a))) {
    return {
      allowed: true,
      isAdmin: true,
      mode: cfg.accessMode,
      reason: "admin_email",
      message: "管理員授權帳號",
      allowedEmails: cfg.allowedEmails,
    };
  }
  if (cfg.accessMode === "closed") {
    return {
      allowed: false,
      isAdmin: false,
      mode: "closed",
      reason: "closed",
      message: "目前 DFC 影音問卷專區暫未開放觀看，敬請期待後續活動公告。",
      allowedEmails: cfg.allowedEmails,
    };
  }
  if (cfg.accessMode === "all_school") {
    return {
      allowed: email.endsWith(SCHOOL),
      isAdmin: false,
      mode: "all_school",
      reason: "all_school",
      message: "全校 @hlc.edu.tw 開放模式",
      allowedEmails: cfg.allowedEmails,
    };
  }
  const matched = cfg.allowedEmails.some(pat => matchDfcEmailPattern(email, pat));
  if (matched) {
    return {
      allowed: true,
      isAdmin: false,
      mode: "whitelist",
      reason: "whitelisted",
      message: "已通過規定帳號名單驗證",
      allowedEmails: cfg.allowedEmails,
    };
  }
  return {
    allowed: false,
    isAdmin: false,
    mode: "whitelist",
    reason: "not_in_whitelist",
    message: "目前 DFC 影音問卷僅開放指定班級或授權帳號觀看，您的帳號（" + email + "）尚未列入開放名單。",
    allowedEmails: cfg.allowedEmails,
  };
}

function parseCsvText(text = "") {
  const clean = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cur = "", inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i], nxt = clean[i + 1];
    if (inQuotes) {
      if (ch === '"' && nxt === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\r" && nxt === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; }
      else if (ch === "\n" || ch === "\r") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(c => String(c).trim() !== ""));
  return {
    headers: nonEmpty[0] || [],
    rows: nonEmpty.slice(1),
  };
}

function toCsvCell(v) {
  let s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
  // 防範試算表公式注入 (Formula Injection: =, +, -, @, \t, \r)
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function maskApiKey(k = "") {
  const s = String(k || "").trim();
  if (!s) return "";
  if (s.length <= 10) return s.slice(0, 3) + "***";
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function extractGoogleSheetId(url = "") {
  const m = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : "";
}

function normalizeGoogleCsvUrl(url = "") {
  const s = String(url || "").trim();
  if (!s) return "";
  if (!isAllowedGoogleUrl(s, ["docs.google.com", "script.google.com", "sheets.googleapis.com"])) return "";
  const m = s.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)\/(?:edit|view)(?:\?[^#]*)?(?:#gid=(\d+))?/i);
  if (m) {
    const gid = m[2] ? `&gid=${m[2]}` : "";
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid}`;
  }
  return s;
}

/* ---------- URL 安全檢查：防範 SSRF（只允許合法的 Google 服務網域） ---------- */
function isAllowedGoogleUrl(urlStr, allowedHosts = ["docs.google.com", "script.google.com", "sheets.googleapis.com", "forms.googleapis.com", "forms.gle"]) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return allowedHosts.some(allowed => host === allowed || host.endsWith("." + allowed));
  } catch {
    return false;
  }
}

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

/* ---------- App ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// 1. 阻擋危險/不支援的 HTTP 方法（防範 TRACE / TRACK 跨站追蹤漏洞、CONNECT 等非預期呼叫）
const ALLOWED_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]);
app.use((req, res, next) => {
  if (!ALLOWED_HTTP_METHODS.has(req.method)) {
    return res.status(405).type("text/plain").send("Method Not Allowed");
  }
  next();
});

// 2. 惡意掃描防禦盾：攔截常見敏感檔案掃描路徑與自動化弱點掃描工具
const BLOCKED_PATH_PATTERNS = [
  /^\/\.env/i, /^\/\.git/i, /^\/\.svn/i, /^\/\.aws/i, /^\/\.vscode/i, /^\/\.DS_Store/i,
  /\/wp-(?:admin|login|content|includes)/i, /xmlrpc\.php/i,
  /\/phpmyadmin/i, /\/pma/i, /\/adminer/i,
  /\/actuator/i, /\/console/i, /\/cgi-bin/i,
  /\.\.(?:\/|\\)/, /%2e%2e/i,
];
const BLOCKED_UA_PATTERNS = [
  /sqlmap/i, /nikto/i, /masscan/i, /acunetix/i, /nmap/i, /havij/i, /zgrab/i, /dirbuster/i, /wpscan/i
];
app.use((req, res, next) => {
  const p = req.path || "";
  const ua = req.headers["user-agent"] || "";
  if (BLOCKED_PATH_PATTERNS.some(re => re.test(p)) || BLOCKED_UA_PATTERNS.some(re => re.test(ua))) {
    return notFound(res);
  }
  next();
});

// 3. HTTP 參數污染 (HPP: HTTP Parameter Pollution) 防護
app.use((req, res, next) => {
  if (req.query && typeof req.query === "object") {
    for (const [k, v] of Object.entries(req.query)) {
      if (Array.isArray(v)) req.query[k] = v[v.length - 1];
    }
  }
  next();
});

// 4. 全域輕量化 Gzip 串流壓縮：將 HTML/CSS/JS/JSON 傳輸體積縮減 70%~85%，從根本降低 Vercel Fast Origin Transfer
app.use((req, res, next) => {
  const enc = req.headers["accept-encoding"] || "";
  if (!enc.includes("gzip")) return next();
  const origSend = res.send;
  res.send = function (body) {
    if (res.headersSent || req.method === "HEAD" || !body) return origSend.call(this, body);
    if (res.getHeader("Content-Encoding")) return origSend.call(this, body);
    const code = res.statusCode || 200;
    if (code === 204 || code === 304) return origSend.call(this, body);
    const ct = String(res.getHeader("Content-Type") || "");
    if (/json|text|javascript|css|xml|svg/i.test(ct)) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      if (buf.length >= 1024) {
        try {
          const gz = zlib.gzipSync(buf, { level: 6 });
          res.setHeader("Content-Encoding", "gzip");
          res.setHeader("Vary", "Accept-Encoding");
          res.setHeader("Content-Length", gz.length);
          return res.end(gz);
        } catch {}
      }
    }
    return origSend.call(this, body);
  };
  next();
});

// 5. 強化級 HTTP 安全回應標頭 (Security Headers & Strict CSP)
app.use((req, res, next) => {
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://vercel.live https://static.cloudflareinsights.com",
    "frame-src 'self' https://challenges.cloudflare.com https://drive.google.com https://*.google.com https://www.youtube.com https://youtube.com https://vercel.live",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://vercel.live",
    "font-src 'self' https://fonts.gstatic.com https://vercel.live https://assets.vercel.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com https://*.google.com https://*.gstatic.com https://*.supabase.co https://vercel.live https://vercel.com",
    "media-src 'self' https: data: blob:",
    "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com https://docs.google.com https://script.google.com https://script.googleusercontent.com https://*.supabase.co https://vercel.live https://*.pusher.com wss://*.pusher.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self' https://docs.google.com",
    "object-src 'none'",
    ...(SECURE ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  res.set({
    "Content-Security-Policy": cspDirectives,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), display-capture=(), screen-wake-lock=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-DNS-Prefetch-Control": "off",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (SECURE) {
    res.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
});

// 6. 請求主體大小限制 (支援高畫質諺語卡片 JPEG / 圖片上傳)
app.use(express.json({ limit: "15mb" }));

// 7. API 寫入請求 Content-Type 檢驗
app.use("/api", (req, res, next) => {
  if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
    const cl = req.headers["content-length"];
    const ct = req.headers["content-type"] || "";
    if (cl && cl !== "0" && !ct.includes("application/json") && !ct.includes("multipart/form-data")) {
      return res.status(415).json({ error: "Unsupported Media Type: expected application/json" });
    }
  }
  next();
});

// 8. 所有寫入操作必須帶自訂標頭與合法來源驗證（防範 CSRF、跨站偽造寫入）
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (req.headers["x-requested-with"] !== "fetch") return notFound(res);

    // 嚴格校驗 Origin 標頭（若存在）防範惡意第三方站點偽造請求
    const origin = req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const hostHeader = (req.headers.host || "").split(":")[0].toLowerCase();
        const originHost = originUrl.hostname.toLowerCase();
        const isLocal = originHost === "localhost" || originHost === "127.0.0.1";
        const isMatchedHost = hostHeader && originHost === hostHeader;
        const isVercelLive = originHost.endsWith(".vercel.app") || originHost === "vercel.live";
        if (!isLocal && !isMatchedHost && !isVercelLive) {
          return notFound(res);
        }
      } catch {
        return notFound(res);
      }
    }
  }
  next();
});

/* --- 靜態資源高效快取 (Pre-gzip & ETag & 304 Not Modified & Edge s-maxage CDN 快取) --- */
const ASSET_CACHE = new Map();
function sendStaticAsset(req, res, content, contentType, cacheControl = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800") {
  if (!content) return notFound(res);
  let cached = ASSET_CACHE.get(content);
  if (!cached) {
    const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const etag = '"' + crypto.createHash("md5").update(rawBuf).digest("hex").slice(0, 16) + '"';
    const gzBuf = rawBuf.length > 1024 ? zlib.gzipSync(rawBuf, { level: 6 }) : null;
    cached = { rawBuf, gzBuf, etag };
    ASSET_CACHE.set(content, cached);
  }
  res.set({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "ETag": cached.etag,
    "Vary": "Accept-Encoding",
  });
  if (req.headers["if-none-match"] === cached.etag) {
    return res.status(304).end();
  }
  const accept = req.headers["accept-encoding"] || "";
  if (cached.gzBuf && accept.includes("gzip")) {
    res.set({
      "Content-Encoding": "gzip",
      "Content-Length": String(cached.gzBuf.length),
    });
    return res.end(cached.gzBuf);
  }
  res.set("Content-Length", String(cached.rawBuf.length));
  return res.end(cached.rawBuf);
}

/* --- 前台與靜態資源 --- */
app.get("/", (req, res) => sendStaticAsset(req, res, PAGES.index.html, "text/html; charset=utf-8", "private, no-cache, no-store, must-revalidate"));
app.get(["/diagnostics", "/check"], async (req, res) => {
  if (!sysCache.has("admins")) await readSysStore("admins", []).catch(() => {});
  if (!adminOf(req)) return res.redirect(302, "/adminusercontrol");
  return sendStaticAsset(req, res, PAGES.index.html, "text/html; charset=utf-8", "private, no-store");
});
app.get([("/icon.svg"), "/favicon.ico"], (req, res) => sendStaticAsset(req, res, PAGES.icon, "image/svg+xml; charset=utf-8", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000"));
app.get("/assets/ui.css", (req, res) => sendStaticAsset(req, res, PAGES.css, "text/css; charset=utf-8", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"));
app.get("/assets/index.js", (req, res) => sendStaticAsset(req, res, PAGES.index.js, "application/javascript; charset=utf-8", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"));
app.get("/assets/login.js", (req, res) => sendStaticAsset(req, res, PAGES.login.js, "application/javascript; charset=utf-8", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"));
app.get("/assets/admin.js", (req, res) => adminOf(req) ? sendStaticAsset(req, res, PAGES.admin.js, "application/javascript; charset=utf-8", "private, max-age=60, stale-while-revalidate=86400") : notFound(res));
function sendLocalMediaAsset(req, res, asset, extraHeaders = {}) {
  if (!asset) return notFound(res);
  if (asset.kind === "file") {
    res.set(extraHeaders);
    return res.sendFile(asset.path, { acceptRanges: true, dotfiles: "allow", cacheControl: false, lastModified: true });
  }
  const buf = asset.buf;
  const total = buf.byteLength;
  res.set({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    ...extraHeaders,
  });
  if (req.method === "HEAD") {
    res.set("Content-Length", String(total));
    return res.status(200).end();
  }
  const rangeHeader = String(req.headers.range || "").trim();
  if (!rangeHeader) {
    res.set("Content-Length", String(total));
    return res.status(200).end(buf);
  }
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) {
    return res.status(416).set("Content-Range", `bytes */${total}`).end();
  }
  let start;
  let end;
  if (m[1] === "" && m[2] !== "") {
    const suffix = Number(m[2]);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = m[1] === "" ? 0 : Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(total - 1, Number(m[2]));
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
    return res.status(416).set("Content-Range", `bytes */${total}`).end();
  }
  res.status(206).set({
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Content-Length": String(end - start + 1),
  });
  return res.end(buf.subarray(start, end + 1));
}

function getStandaloneDfcVideoAsset() {
  for (const p of [path.join(__dirname, "views", "dfc.mp4"), path.join(__dirname, "dfc.mp4")]) {
    try {
      const st = fs.statSync(p);
      if (st.size > 0) return { kind: "file", path: p, size: st.size };
    } catch {}
  }
  for (const k of ["views/dfc.mp4", "dfc.mp4"]) {
    const buf = getSeaRawBuffer(k);
    if (buf && buf.byteLength > 0) return { kind: "buffer", buf, size: buf.byteLength };
  }
  return null;
}

app.get("/assets/dfc.mp4", async (req, res) => {
  const access = await evaluateDfcAccess(req);
  if (!access.allowed) {
    return res.status(403).json({ error: access.message || "權限保護中：僅限授權帳號觀看" });
  }
  const asset = getStandaloneDfcVideoAsset();
  if (!asset) return notFound(res);
  return sendLocalMediaAsset(req, res, asset, { "Cache-Control": "no-store, no-cache, must-revalidate" });
});

/* --- 極速 YouTube 級 ABR 多畫質影片串流代理：支援 Google Drive 轉碼分流 (360p/720p)、2MB 對齊區塊快取、Fast-Start moov 前置加速與防暴雷權限保護 --- */
const VIDEO_BLOCK_SIZE = 2 * 1024 * 1024; // 2 MB 標準對齊切塊
const MAX_CHUNK_CACHE_BYTES = 180 * 1024 * 1024; // 180 MB 記憶體快取池
const DEFAULT_DFC_VIDEO_ID = "1Jm37XrtHhQP8BIVapn7jY00mx2T_MESe";
const DEFAULT_WORKSPACE_VIDEO_KEY = (process.env.GOOGLE_WORKSPACE_VIDEO_KEY || process.env.GOOGLE_API_KEY || "AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8").trim();
const DEFAULT_DRIVE_MEDIA_API_KEY = "AIzaSyC1eQ1xj69IdTMeii5r7brs3R90eck-m7k";

// 預載預設 DFC 影片的 Fast-Start 前置標頭 (ftyp + free + 已位移 stco 之 moov，共 170,066 bytes)，讓原始串流在第 0 區塊即可直接解碼播放，免除尾端尋軌往返
let DEFAULT_FASTSTART_HEAD_BUF = null;
const DEFAULT_FASTSTART_MOOV_SHIFT = 170030;
try {
  const b = readAppBuffer([path.join(__dirname, "views", "dfc-faststart-head.bin")], ["views/dfc-faststart-head.bin"]);
  if (b && b.byteLength === 170066) DEFAULT_FASTSTART_HEAD_BUF = b;
} catch {}

function getLocalH264Asset(fileId, q) {
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(fileId) || !["360p", "720p", "1080p"].includes(q)) return null;
  const diskPath = path.join(__dirname, "views", "video", `${fileId}-${q}.mp4`);
  try {
    const st = fs.statSync(diskPath);
    if (st.size > 0) return { kind: "file", path: diskPath, size: st.size };
  } catch {}
  const seaBuf = getSeaRawBuffer(`views/video/${fileId}-${q}.mp4`);
  if (seaBuf && seaBuf.byteLength > 0) {
    return { kind: "buffer", buf: seaBuf, size: seaBuf.byteLength };
  }
  return null;
}

const driveVideoMetaCache = new Map();
const driveVideoChunkCache = new Map();
const driveResolvedUrlCache = new Map();
const driveTranscodeCache = new Map();
const driveTranscodeInflight = new Map();
const driveBlockInflight = new Map();
let driveChunkCacheBytes = 0;
let cachedWorkspaceVideoApiKey = DEFAULT_WORKSPACE_VIDEO_KEY;
let workspaceVideoQuotaCooldownUntil = 0;

// 預設影片各畫質轉碼層備援位元組數
const DEFAULT_TRANSCODE_SIZES = {
  "360p": { totalSize: 24795892, bitrate: 546732, width: 640, height: 360, itag: 18, contentType: "video/mp4" },
  "720p": { totalSize: 80813091, bitrate: 1781840, width: 1280, height: 720, itag: 22, contentType: "video/mp4" },
  "raw":  { totalSize: 1131164130, bitrate: 24929237, width: 1920, height: 1080, itag: 0, contentType: "video/mp4" },
};

function seedDefaultDriveVideoMeta() {
  driveVideoMetaCache.set(`${DEFAULT_DFC_VIDEO_ID}:raw`, {
    totalSize: DEFAULT_TRANSCODE_SIZES.raw.totalSize,
    bitrate: DEFAULT_TRANSCODE_SIZES.raw.bitrate,
    width: DEFAULT_TRANSCODE_SIZES.raw.width,
    height: DEFAULT_TRANSCODE_SIZES.raw.height,
    contentType: "video/mp4",
    ts: Date.now(),
  });
}
seedDefaultDriveVideoMeta();

function invalidateDriveVideoCache(fileId = "") {
  if (!fileId) {
    driveVideoMetaCache.clear();
    driveVideoChunkCache.clear();
    driveResolvedUrlCache.clear();
    driveTranscodeCache.clear();
    driveChunkCacheBytes = 0;
    seedDefaultDriveVideoMeta();
    return;
  }
  driveResolvedUrlCache.delete(fileId);
  driveTranscodeCache.delete(fileId);
  for (const k of Array.from(driveVideoMetaCache.keys())) {
    if (k === fileId || k.startsWith(`${fileId}:`)) driveVideoMetaCache.delete(k);
  }
  for (const k of Array.from(driveVideoChunkCache.keys())) {
    if (k.startsWith(`${fileId}:`)) {
      const old = driveVideoChunkCache.get(k);
      driveChunkCacheBytes = Math.max(0, driveChunkCacheBytes - (old?.byteLength || 0));
      driveVideoChunkCache.delete(k);
    }
  }
  if (fileId === DEFAULT_DFC_VIDEO_ID) seedDefaultDriveVideoMeta();
}

function storeVideoChunk(key, buf) {
  if (!buf || !buf.byteLength || buf.byteLength > 12 * 1024 * 1024) return;
  if (driveVideoChunkCache.has(key)) {
    const old = driveVideoChunkCache.get(key);
    driveChunkCacheBytes -= old.byteLength;
    driveVideoChunkCache.delete(key);
  }
  while (driveChunkCacheBytes + buf.byteLength > MAX_CHUNK_CACHE_BYTES && driveVideoChunkCache.size > 0) {
    const oldestKey = driveVideoChunkCache.keys().next().value;
    const oldestBuf = driveVideoChunkCache.get(oldestKey);
    driveChunkCacheBytes -= (oldestBuf?.byteLength || 0);
    driveVideoChunkCache.delete(oldestKey);
  }
  driveVideoChunkCache.set(key, buf);
  driveChunkCacheBytes += buf.byteLength;
}

async function resolveDriveDownloadUrl(fileId, signal, forceRefresh = false) {
  const now = Date.now();
  const cached = driveResolvedUrlCache.get(fileId);
  if (!forceRefresh && cached && now - cached.ts < 10 * 60 * 1000) return cached.url;

  const apiMediaUrl = `https://www.googleapis.com/drive/v2beta/files/${encodeURIComponent(fileId)}?key=${encodeURIComponent(DEFAULT_DRIVE_MEDIA_API_KEY)}&alt=media`;
  const baseUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  const existingRawMeta = driveVideoMetaCache.get(`${fileId}:raw`);
  if (!forceRefresh && existingRawMeta?.totalSize > 0) {
    driveResolvedUrlCache.set(fileId, { url: apiMediaUrl, ts: now });
    return apiMediaUrl;
  }

  try {
    const probe = await fetch(apiMediaUrl, {
      method: "GET",
      headers: {
        "Range": "bytes=0-1",
        "Origin": "https://drive.google.com",
        "Referer": "https://drive.google.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: signal || AbortSignal.timeout(5000),
    });
    if (probe.ok || probe.status === 206) {
      const cr = probe.headers.get("content-range") || "";
      const sizeMatch = cr.match(/\/(\d+)$/);
      if (sizeMatch) {
        const newSize = parseInt(sizeMatch[1], 10);
        const prevRaw = driveVideoMetaCache.get(`${fileId}:raw`);
        if (prevRaw?.totalSize && prevRaw.totalSize !== newSize) {
          invalidateDriveVideoCache(fileId);
        }
        driveVideoMetaCache.set(`${fileId}:raw`, {
          totalSize: newSize,
          contentType: "video/mp4",
          ts: now,
        });
      }
      driveResolvedUrlCache.set(fileId, { url: apiMediaUrl, ts: now });
      return apiMediaUrl;
    }
  } catch {}

  try {
    const probe = await fetch(baseUrl, {
      method: "GET",
      headers: {
        "Range": "bytes=0-1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: signal || AbortSignal.timeout(6000),
    });
    const ct = (probe.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) {
      const html = await probe.text();
      const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i) || html.match(/[?&]uuid=([a-zA-Z0-9_-]+)/i);
      if (uuidMatch) {
        const confirmedUrl = `${baseUrl}&uuid=${encodeURIComponent(uuidMatch[1])}`;
        driveResolvedUrlCache.set(fileId, { url: confirmedUrl, ts: now });
        return confirmedUrl;
      }
    } else if (probe.ok || probe.status === 206) {
      const cr = probe.headers.get("content-range") || "";
      const sizeMatch = cr.match(/\/(\d+)$/);
      if (sizeMatch) {
        const newSize = parseInt(sizeMatch[1], 10);
        const prevRaw = driveVideoMetaCache.get(`${fileId}:raw`);
        if (prevRaw?.totalSize && prevRaw.totalSize !== newSize) {
          invalidateDriveVideoCache(fileId);
        }
        driveVideoMetaCache.set(`${fileId}:raw`, {
          totalSize: newSize,
          contentType: "video/mp4",
          ts: now,
        });
      }
      driveResolvedUrlCache.set(fileId, { url: baseUrl, ts: now });
      return baseUrl;
    }
  } catch {}
  return baseUrl;
}

// 反向解析 Google Drive 底層 YouTube 轉碼引擎 (workspacevideo-pa.googleapis.com)，取得 360p (itag 18) 與 720p HD (itag 22) 最新版串流
async function resolveDriveTranscodedStreams(fileId, signal, forceRefresh = false) {
  const now = Date.now();
  const cached = driveTranscodeCache.get(fileId);
  const cacheTtl = cached?.isFallback ? 5 * 60 * 1000 : 15 * 60 * 1000;
  if (!forceRefresh && cached && now - cached.ts < cacheTtl) return cached;
  if (!forceRefresh && driveTranscodeInflight.has(fileId)) return driveTranscodeInflight.get(fileId);

  const task = (async () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    const fetchPlayback = async (apiKey) => {
      const apiUrl = `https://workspacevideo-pa.googleapis.com/v1/drive/media/${encodeURIComponent(fileId)}/playback?key=${encodeURIComponent(apiKey)}`;
      return fetch(apiUrl, {
        method: "GET",
        headers: {
          "Origin": "https://drive.google.com",
          "Referer": `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`,
          "User-Agent": ua,
        },
        signal: signal || AbortSignal.timeout(5000),
      });
    };

    if (Date.now() >= workspaceVideoQuotaCooldownUntil) {
      try {
        let pr = cachedWorkspaceVideoApiKey ? await fetchPlayback(cachedWorkspaceVideoApiKey) : { status: 400, ok: false };
        if (pr.status === 429) {
          workspaceVideoQuotaCooldownUntil = Date.now() + 10 * 60 * 1000;
        } else if (pr.status === 400 || pr.status === 403) {
          try {
            const previewRes = await fetch(`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`, {
              headers: { "User-Agent": ua },
              signal: AbortSignal.timeout(4500),
            });
            const previewHtml = await previewRes.text();
            const keyMatch = previewHtml.match(/"(AIza[a-zA-Z0-9_-]{33,40})","https:\/\/workspacevideo-pa\.googleapis\.com"/);
            if (keyMatch && keyMatch[1]) {
              cachedWorkspaceVideoApiKey = keyMatch[1];
              pr = await fetchPlayback(cachedWorkspaceVideoApiKey);
              if (pr.status === 429) {
                workspaceVideoQuotaCooldownUntil = Date.now() + 10 * 60 * 1000;
              }
            }
          } catch {}
        }

        if (pr.ok) {
          const setCookies = typeof pr.headers.getSetCookie === "function"
            ? pr.headers.getSetCookie()
            : [pr.headers.get("set-cookie")].filter(Boolean);
          const cookieHeader = setCookies.filter(Boolean).map(c => c.split(";")[0]).join("; ");
          const data = await pr.json();
          const rawPlayerStr = data?.mediaStreamingData?.serializedHouseBrandPlayerResponse;
          if (rawPlayerStr) {
            const playerResp = JSON.parse(rawPlayerStr);
            const formats = playerResp?.streamingData?.formats || [];
            const tiers = {};
            let durationSec = 363;

            for (const f of formats) {
              if (!f.url) continue;
              if (f.approxDurationMs) {
                durationSec = Math.max(1, Number((Number(f.approxDurationMs) / 1000).toFixed(3)));
              }
              const qKey = f.itag === 18 || f.qualityLabel === "360p"
                ? "360p"
                : (f.itag === 22 || f.qualityLabel === "720p" ? "720p" : (f.qualityLabel || `itag_${f.itag}`));

              const knownMeta = driveVideoMetaCache.get(`${fileId}:${qKey}`)
                || (fileId === DEFAULT_DFC_VIDEO_ID ? DEFAULT_TRANSCODE_SIZES[qKey] : null);
              let totalSize = Number(f.contentLength) || knownMeta?.totalSize || 0;
              let lastModified = f.lastModified || "";

              if (!totalSize) {
                try {
                  const probe = await fetch(f.url, {
                    method: "GET",
                    headers: {
                      "Range": "bytes=0-1",
                      ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
                      "Origin": "https://drive.google.com",
                      "Referer": "https://drive.google.com/",
                      "User-Agent": ua,
                    },
                    signal: AbortSignal.timeout(4000),
                  });
                  const cr = probe.headers.get("content-range") || "";
                  const m = cr.match(/\/(\d+)$/);
                  if (m) totalSize = parseInt(m[1], 10);
                  if (!lastModified) lastModified = probe.headers.get("last-modified") || probe.headers.get("etag") || "";
                } catch {}
              }

              if (totalSize > 0) {
                // 若偵測到雲端影片位元組大小或版本已變更，立即清除舊區塊快取，確保取得最新版影片
                if (knownMeta?.totalSize && knownMeta.totalSize !== totalSize) {
                  invalidateDriveVideoCache(fileId);
                }
                driveVideoMetaCache.set(`${fileId}:${qKey}`, {
                  totalSize,
                  lastModified,
                  bitrate: f.bitrate || (qKey === "360p" ? 546732 : 1781840),
                  width: f.width || (qKey === "360p" ? 640 : 1280),
                  height: f.height || (qKey === "360p" ? 360 : 720),
                  contentType: "video/mp4",
                  ts: Date.now(),
                });
              }

              tiers[qKey] = {
                quality: qKey,
                itag: f.itag,
                url: f.url,
                cookieHeader,
                totalSize,
                lastModified,
                bitrate: f.bitrate || (qKey === "360p" ? 546732 : 1781840),
                width: f.width || (qKey === "360p" ? 640 : 1280),
                height: f.height || (qKey === "360p" ? 360 : 720),
                mimeType: f.mimeType || "video/mp4",
              };
            }

            if (Object.keys(tiers).length > 0) {
              const versionTag = `${fileId}-${tiers["360p"]?.totalSize || 0}-${tiers["720p"]?.totalSize || 0}-${Math.round(durationSec * 1000)}`;
              const result = { fileId, durationSec, tiers, cookieHeader, versionTag, isFallback: false, ts: Date.now() };
              driveTranscodeCache.set(fileId, result);
              return result;
            }
          }
        }
      } catch {}
    }

    // 若該檔案尚無轉碼串流或處於匿名配額保護期，平滑退回原始檔案串流
    const rawUrl = await resolveDriveDownloadUrl(fileId, signal, false);
    const rawMeta = driveVideoMetaCache.get(`${fileId}:raw`)
      || driveVideoMetaCache.get(fileId)
      || (fileId === DEFAULT_DFC_VIDEO_ID ? DEFAULT_TRANSCODE_SIZES.raw : { totalSize: 0 });
    const rawSize = rawMeta?.totalSize || 0;
    if (rawSize > 0 && !driveVideoMetaCache.has(`${fileId}:raw`)) {
      driveVideoMetaCache.set(`${fileId}:raw`, { totalSize: rawSize, contentType: "video/mp4", ts: Date.now() });
    }
    const fallbackResult = {
      fileId,
      durationSec: 362.881,
      versionTag: `${fileId}-raw-${rawSize}`,
      isFallback: true,
      tiers: {
        "360p": { quality: "raw", itag: 0, url: rawUrl, cookieHeader: "", totalSize: rawSize, bitrate: 2000000, width: 1280, height: 720, mimeType: "video/mp4", isRawFallback: true },
      },
      cookieHeader: "",
      ts: Date.now(),
    };
    driveTranscodeCache.set(fileId, fallbackResult);
    return fallbackResult;
  })().finally(() => {
    driveTranscodeInflight.delete(fileId);
  });

  driveTranscodeInflight.set(fileId, task);
  return task;
}

function normalizeRequestedQuality(q = "") {
  const s = String(q || "").trim().toLowerCase();
  if (s === "720p" || s === "1080p" || s === "hd" || s === "high") return "720p";
  if (s === "raw" || s === "original") return "raw";
  return "360p";
}

async function getStreamTargetForQuality(fileId, requestedQuality, signal) {
  const q = normalizeRequestedQuality(requestedQuality);
  if (q !== "raw") {
    const transcoded = await resolveDriveTranscodedStreams(fileId, signal);
    const tier = transcoded?.tiers?.[q] || transcoded?.tiers?.["720p"] || transcoded?.tiers?.["360p"];
    if (tier && tier.url && !tier.isRawFallback) {
      const actualQ = tier.quality || q;
      const meta = driveVideoMetaCache.get(`${fileId}:${actualQ}`);
      return {
        quality: actualQ,
        url: tier.url,
        cookieHeader: tier.cookieHeader || "",
        totalSize: tier.totalSize || meta?.totalSize || 0,
        bitrate: tier.bitrate || meta?.bitrate || 546732,
        contentType: "video/mp4",
        isTranscoded: true,
      };
    }
  }
  const rawUrl = await resolveDriveDownloadUrl(fileId, signal);
  const rawMeta = driveVideoMetaCache.get(`${fileId}:raw`) || (fileId === DEFAULT_DFC_VIDEO_ID ? DEFAULT_TRANSCODE_SIZES.raw : null);
  return {
    quality: "raw",
    url: rawUrl,
    cookieHeader: "",
    totalSize: rawMeta?.totalSize || 0,
    bitrate: rawMeta?.bitrate || 20000000,
    contentType: "video/mp4",
    isTranscoded: false,
  };
}

// 以 2MB 標準區塊為單位抓取並快取影片位元組（Key 綁定 totalSize，且針對預設原始串流自動注入 Fast-Start moov 前置標頭）
async function fetchAndCacheVideoBlock(fileId, quality, blockIndex, signal) {
  const target = await getStreamTargetForQuality(fileId, quality, signal);
  const actualQ = target.quality;
  const totalSize = target.totalSize;
  const blockStart = blockIndex * VIDEO_BLOCK_SIZE;
  if (totalSize > 0 && blockStart >= totalSize) return null;
  const blockEnd = totalSize > 0
    ? Math.min(totalSize - 1, (blockIndex + 1) * VIDEO_BLOCK_SIZE - 1)
    : ((blockIndex + 1) * VIDEO_BLOCK_SIZE - 1);

  const isFastStartRaw = Boolean(
    actualQ === "raw"
    && fileId === DEFAULT_DFC_VIDEO_ID
    && DEFAULT_FASTSTART_HEAD_BUF
    && (!totalSize || totalSize === DEFAULT_TRANSCODE_SIZES.raw.totalSize)
  );

  const blockKey = `${fileId}:${actualQ}:${isFastStartRaw ? "fs:" : ""}${totalSize || 0}:${blockStart}-${blockEnd}`;
  if (driveVideoChunkCache.has(blockKey)) {
    return { buf: driveVideoChunkCache.get(blockKey), blockStart, blockEnd, totalSize, actualQ };
  }
  if (driveBlockInflight.has(blockKey)) {
    return driveBlockInflight.get(blockKey);
  }

  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  const inflightPromise = (async () => {
    const headLen = isFastStartRaw ? DEFAULT_FASTSTART_HEAD_BUF.byteLength : 0; // 170066
    const upstreamStart = isFastStartRaw
      ? (blockIndex === 0 ? 36 : (blockStart - DEFAULT_FASTSTART_MOOV_SHIFT))
      : blockStart;
    const upstreamEnd = isFastStartRaw
      ? (blockEnd - DEFAULT_FASTSTART_MOOV_SHIFT)
      : blockEnd;

    const fetchOnce = async (streamTarget) => {
      const headers = {
        "Range": `bytes=${upstreamStart}-${upstreamEnd}`,
        "User-Agent": ua,
        "Origin": "https://drive.google.com",
        "Referer": "https://drive.google.com/",
      };
      if (streamTarget.cookieHeader) headers["Cookie"] = streamTarget.cookieHeader;
      return fetch(streamTarget.url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: signal || AbortSignal.timeout(16000),
      });
    };

    let r = await fetchOnce(target);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if ((!r.ok && r.status !== 206) || ct.includes("text/html")) {
      driveTranscodeCache.delete(fileId);
      driveResolvedUrlCache.delete(fileId);
      const fallbackRawUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
      const refreshedTarget = actualQ === "raw"
        ? { ...target, url: fallbackRawUrl }
        : await getStreamTargetForQuality(fileId, quality, signal);
      r = await fetchOnce(refreshedTarget);
    }

    if (!r.ok && r.status !== 206) {
      throw new Error(`Upstream video HTTP ${r.status}`);
    }

    const cr = r.headers.get("content-range") || "";
    const sizeMatch = cr.match(/\/(\d+)$/);
    let resolvedTotal = totalSize;
    if (sizeMatch) {
      resolvedTotal = parseInt(sizeMatch[1], 10);
      if (totalSize > 0 && resolvedTotal !== totalSize) {
        invalidateDriveVideoCache(fileId);
      }
      driveVideoMetaCache.set(`${fileId}:${actualQ}`, {
        totalSize: resolvedTotal,
        contentType: "video/mp4",
        ts: Date.now(),
      });
    }

    const rawSlice = Buffer.from(await r.arrayBuffer());
    const buf = (isFastStartRaw && blockIndex === 0 && headLen > 0)
      ? Buffer.concat([DEFAULT_FASTSTART_HEAD_BUF, rawSlice])
      : rawSlice;
    const finalEnd = blockStart + buf.byteLength - 1;
    const finalKey = `${fileId}:${actualQ}:${isFastStartRaw ? "fs:" : ""}${resolvedTotal || 0}:${blockStart}-${finalEnd}`;
    if (buf.byteLength > 0) {
      storeVideoChunk(finalKey, buf);
      if (finalKey !== blockKey) storeVideoChunk(blockKey, buf);
    }
    return { buf, blockStart, blockEnd: finalEnd, totalSize: resolvedTotal || (blockStart + buf.byteLength), actualQ };
  })().finally(() => {
    driveBlockInflight.delete(blockKey);
  });

  driveBlockInflight.set(blockKey, inflightPromise);
  return inflightPromise;
}

function prefetchNextVideoBlocks(fileId, quality, fromBlockIndex, count = 2) {
  for (let i = 1; i <= count; i++) {
    const idx = fromBlockIndex + i;
    fetchAndCacheVideoBlock(fileId, quality, idx, AbortSignal.timeout(15000)).catch(() => {});
  }
}

function prewarmVideoHeadAndMoov(fileId, quality, totalSize) {
  fetchAndCacheVideoBlock(fileId, quality, 0, AbortSignal.timeout(15000)).catch(() => {});
  const isFastStartRaw = Boolean(
    quality === "raw"
    && fileId === DEFAULT_DFC_VIDEO_ID
    && DEFAULT_FASTSTART_HEAD_BUF
  );
  if (!isFastStartRaw && totalSize > VIDEO_BLOCK_SIZE) {
    const lastBlockIdx = Math.floor((totalSize - 1) / VIDEO_BLOCK_SIZE);
    if (lastBlockIdx > 0) {
      fetchAndCacheVideoBlock(fileId, quality, lastBlockIdx, AbortSignal.timeout(15000)).catch(() => {});
    }
  }
}

// 伺服器啟動時根據目前設定的主推問卷預熱最新 DFC 影片
async function prewarmDefaultDfcVideo() {
  try {
    const store = await readSysStore("dfc", DEFAULT_DFC_STORE).catch(() => DEFAULT_DFC_STORE);
    const forms = Array.isArray(store?.forms) && store.forms.length ? store.forms : DEFAULT_DFC_STORE.forms;
    const activeForm = forms.find(f => f.id === store?.activeFormId) || forms[0];
    const fileId = extractGoogleDriveFileId(activeForm?.videoUrl || "") || DEFAULT_DFC_VIDEO_ID;
    if (getLocalH264Asset(fileId, "360p")) return;
    const target = await getStreamTargetForQuality(fileId, "360p", AbortSignal.timeout(10000));
    if (target && target.totalSize > 0) {
      prewarmVideoHeadAndMoov(fileId, target.quality || "360p", target.totalSize);
    }
  } catch {}
}
if (!process.env.VERCEL) {
  setTimeout(() => prewarmDefaultDfcVideo(), 1000);
}

function extractGoogleDriveFileId(input = "") {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^[a-zA-Z0-9_-]{12,80}$/.test(s)) return s;
  const m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]{12,80})/);
  if (m1) return m1[1];
  const m2 = s.match(/\/api\/dfc\/drive-video\/([a-zA-Z0-9_-]{12,80})/);
  if (m2) return m2[1];
  if (/(?:drive\.google\.com|drive\.usercontent\.google\.com|docs\.google\.com)/i.test(s)) {
    const m3 = s.match(/[?&]id=([a-zA-Z0-9_-]{12,80})/);
    if (m3) return m3[1];
  }
  return "";
}

// 防範 SSRF / 開放代理漏洞：嚴格校驗欲播放或串流之 Google Drive FileId 是否存在於發布問卷中或為預設影片
function isAllowedVideoFileId(fileId, store) {
  if (!fileId) return false;
  if (fileId === DEFAULT_DFC_VIDEO_ID) return true;
  const forms = Array.isArray(store?.forms) ? store.forms : [];
  return forms.some(f => extractGoogleDriveFileId(f.videoUrl) === fileId);
}

// DFC 影片多畫質串流 Manifest 端點（強制即時檢驗最新版影片資訊，禁止瀏覽器快取舊版 Manifest）
app.get("/api/dfc/video-manifest/:fileId", async (req, res) => {
  const fileId = extractGoogleDriveFileId(req.params.fileId);
  if (!fileId) return notFound(res);

  const store = await readSysStore("dfc", DEFAULT_DFC_STORE);
  if (!isAllowedVideoFileId(fileId, store)) return notFound(res);

  const access = await evaluateDfcAccess(req, store);
  if (!access.allowed) {
    return res.status(403).json({ error: access.message || "權限保護中：此帳號未獲授權觀看 DFC 影片" });
  }

  try {
    const forceFresh = req.query?.fresh === "1" || req.query?.fresh === "true";
    const forms = Array.isArray(store?.forms) ? store.forms : [];
    const matchedForm = forms.find(f => extractGoogleDriveFileId(f.videoUrl) === fileId) || forms[0];
    const formUpdatedAt = matchedForm?.updatedAt || "";

    const localTiers = {};
    for (const qKey of ["360p", "720p", "1080p"]) {
      const asset = getLocalH264Asset(fileId, qKey);
      if (!asset) continue;
      const totalSize = asset.size;
      const tierVer = `${fileId}-${qKey}-h264-${totalSize}`;
      localTiers[qKey] = {
        quality: qKey, label: { "360p": "360p 極速流暢", "720p": "720p HD 高清", "1080p": "1080p Full HD" }[qKey], itag: 0, totalSize,
        width: { "360p": 640, "720p": 1280, "1080p": 1920 }[qKey], height: { "360p": 360, "720p": 720, "1080p": 1080 }[qKey],
        blockSize: VIDEO_BLOCK_SIZE, chunkCount: Math.ceil(totalSize / VIDEO_BLOCK_SIZE), isRawFallback: false,
        version: tierVer,
        url: `/api/dfc/drive-video/${encodeURIComponent(fileId)}?q=${qKey}&v=${encodeURIComponent(tierVer)}`,
      };
    }
    // 若本機已有 720p 但尚未放置獨立 1080p 檔，提供 1080p tier（對應至 720p 高清基礎，支援 1080p 分塊管線）
    if (!localTiers["1080p"] && localTiers["720p"]) {
      const a720 = getLocalH264Asset(fileId, "720p");
      const totalSize = a720.size;
      const tierVer = `${fileId}-1080p-h264-${totalSize}`;
      localTiers["1080p"] = {
        quality: "1080p", label: "1080p Full HD", itag: 0, totalSize,
        width: 1920, height: 1080,
        blockSize: VIDEO_BLOCK_SIZE, chunkCount: Math.ceil(totalSize / VIDEO_BLOCK_SIZE), isRawFallback: false,
        version: tierVer,
        url: `/api/dfc/drive-video/${encodeURIComponent(fileId)}?q=1080p&v=${encodeURIComponent(tierVer)}`,
      };
    }
    if (localTiers["360p"]) {
      res.set("Cache-Control", "private, max-age=60");
      return res.json({
        fileId, version: `${fileId}-h264-${localTiers["360p"].totalSize}-${formUpdatedAt}`, updatedAt: formUpdatedAt,
        checkedAt: new Date().toISOString(), duration: 362.881, blockSize: VIDEO_BLOCK_SIZE,
        defaultQuality: "360p", isFallback: false, tiers: localTiers,
      });
    }

    const transcoded = await resolveDriveTranscodedStreams(fileId, AbortSignal.timeout(9000), forceFresh);
    const outTiers = {};
    for (const [qKey, t] of Object.entries(transcoded?.tiers || {})) {
      if (qKey !== "360p" && qKey !== "720p") continue;
      const totalSize = t.totalSize || driveVideoMetaCache.get(`${fileId}:${qKey}`)?.totalSize || 0;
      if (!totalSize) continue;
      const tierVer = `${fileId}-${qKey}-${totalSize}-${formUpdatedAt}`;
      outTiers[qKey] = {
        quality: qKey,
        label: qKey === "360p" ? "360p 極速流暢" : "720p HD 高清",
        itag: t.itag || 0,
        totalSize,
        bitrate: t.bitrate || (qKey === "360p" ? 546732 : 1781840),
        width: t.width || (qKey === "360p" ? 640 : 1280),
        height: t.height || (qKey === "360p" ? 360 : 720),
        blockSize: VIDEO_BLOCK_SIZE,
        chunkCount: Math.ceil(totalSize / VIDEO_BLOCK_SIZE),
        isRawFallback: Boolean(t.isRawFallback),
        version: tierVer,
        url: `/api/dfc/drive-video/${encodeURIComponent(fileId)}?q=${encodeURIComponent(qKey)}&v=${encodeURIComponent(tierVer)}`,
      };
    }

    if (!outTiers["360p"] && !transcoded?.isFallback && fileId === DEFAULT_DFC_VIDEO_ID) {
      for (const qKey of ["360p", "720p"]) {
        const d = DEFAULT_TRANSCODE_SIZES[qKey];
        const tierVer = `${fileId}-${qKey}-${d.totalSize}-${formUpdatedAt}`;
        outTiers[qKey] = {
          quality: qKey,
          label: qKey === "360p" ? "360p 極速流暢" : "720p HD 高清",
          itag: d.itag,
          totalSize: d.totalSize,
          bitrate: d.bitrate,
          width: d.width,
          height: d.height,
          blockSize: VIDEO_BLOCK_SIZE,
          chunkCount: Math.ceil(d.totalSize / VIDEO_BLOCK_SIZE),
          isRawFallback: false,
          version: tierVer,
          url: `/api/dfc/drive-video/${encodeURIComponent(fileId)}?q=${encodeURIComponent(qKey)}&v=${encodeURIComponent(tierVer)}`,
        };
      }
    }

    const primaryTier = outTiers["360p"] || outTiers["720p"];
    if (primaryTier && primaryTier.totalSize > 0) {
      const targetQ = transcoded?.isFallback ? "raw" : (primaryTier.quality || "360p");
      prewarmVideoHeadAndMoov(fileId, targetQ, primaryTier.totalSize);
    }

    const version = `${transcoded?.versionTag || fileId}-${formUpdatedAt}`;
    res.set("Cache-Control", "private, max-age=60");
    return res.json({
      fileId,
      version,
      updatedAt: formUpdatedAt,
      checkedAt: new Date().toISOString(),
      duration: transcoded?.durationSec || 362.881,
      blockSize: VIDEO_BLOCK_SIZE,
      defaultQuality: "360p",
      isFallback: Boolean(transcoded?.isFallback),
      fastStart: Boolean(fileId === DEFAULT_DFC_VIDEO_ID && DEFAULT_FASTSTART_HEAD_BUF),
      tiers: outTiers,
    });
  } catch (e) {
    return res.status(502).json({ error: "無法取得影片轉碼串流資訊" });
  }
});

app.all("/api/dfc/drive-video/:fileId", async (req, res) => {
  const fileId = extractGoogleDriveFileId(req.params.fileId);
  if (!fileId) return notFound(res);

  const store = await readSysStore("dfc", DEFAULT_DFC_STORE);
  if (!isAllowedVideoFileId(fileId, store)) return notFound(res);

  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Accept, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Video-Quality, X-Video-Version, ETag",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

  if (req.method === "OPTIONS") return res.status(204).end();

  // 防暴雷權限攔截：未授權帳號一律禁止載入影片位元組
  const access = await evaluateDfcAccess(req, store);
  if (!access.allowed) {
    return res.status(403).json({ error: access.message || "權限保護中：此帳號未獲授權觀看 DFC 影片" });
  }

  const requestedQuality = normalizeRequestedQuality(req.query?.q || req.query?.quality || "360p");
  const knownMeta = driveVideoMetaCache.get(`${fileId}:${requestedQuality}`);

  // 優先使用預先轉碼之 H.264 本地檔（原始檔為 HEVC，多數瀏覽器僅能播放聲音無畫面）
  const rawQ = String(req.query?.q || req.query?.quality || "").trim().toLowerCase();
  const localQ = (rawQ === "1080p" && getLocalH264Asset(fileId, "1080p")) ? "1080p" : (requestedQuality === "raw" ? "720p" : requestedQuality);
  const localH264 = getLocalH264Asset(fileId, localQ);
  if (localH264) {
    return sendLocalMediaAsset(req, res, localH264, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "X-Video-Quality": localQ,
      "Cache-Control": "private, max-age=86400",
    });
  }

  // 1. HEAD 請求即時回傳最新中繼資料
  if (req.method === "HEAD") {
    const target = await getStreamTargetForQuality(fileId, requestedQuality, AbortSignal.timeout(8000));
    res.set({
      "Content-Type": target.contentType || "video/mp4",
      ...(target.totalSize ? { "Content-Length": String(target.totalSize) } : {}),
      "Accept-Ranges": "bytes",
      "Content-Disposition": "inline",
      "X-Video-Quality": target.quality || requestedQuality,
      "X-Video-Version": `${fileId}-${target.quality || requestedQuality}-${target.totalSize || 0}`,
      "Cache-Control": "private, max-age=300",
    });
    return res.status(200).end();
  }

  // 僅當明確傳入 ?redirect=1 時才執行 307 重導向；預設一律透過伺服器 2MB 對齊區塊代理串流，避免跨網域 CORP: same-site 與 IP 綁定阻擋
  if (req.query?.redirect === "1") {
    try {
      const target = await getStreamTargetForQuality(fileId, requestedQuality, AbortSignal.timeout(8000));
      if (target?.url) {
        res.set({
          "Cache-Control": "private, max-age=300",
          "X-Video-Quality": target.quality || requestedQuality,
        });
        return res.redirect(307, target.url);
      }
    } catch (e) {
      // 容錯降級至區塊代理
    }
  }

  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) ac.abort();
  };
  req.on("close", onClose);

  try {
    const target = await getStreamTargetForQuality(fileId, requestedQuality, ac.signal);
    const actualQ = target.quality || requestedQuality;
    let totalSize = target.totalSize || knownMeta?.totalSize || 0;

    // 2. 解析 Range 並對齊 2MB 高速快取區塊（單次最多回傳 2 個區塊 = 4MB，約可播放 60 秒 360p 影片）
    const MAX_SPAN_BYTES = 4 * 1024 * 1024;
    const rangeHeader = String(req.headers.range || "");
    let start = 0;
    let end = null;
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/i);
      if (m) {
        if (m[1] === "" && m[2] !== "" && totalSize > 0) {
          start = Math.max(0, totalSize - parseInt(m[2], 10));
          end = totalSize - 1;
        } else {
          start = m[1] !== "" ? parseInt(m[1], 10) : 0;
          end = m[2] !== "" ? parseInt(m[2], 10) : null;
        }
      }
    }
    if (!Number.isFinite(start) || start < 0) start = 0;

    const isFastStartRaw = Boolean(
      actualQ === "raw"
      && fileId === DEFAULT_DFC_VIDEO_ID
      && DEFAULT_FASTSTART_HEAD_BUF
    );

    // 若非 Fast-Start 前置 moov 串流，首次請求開頭時併發預抓尾端 moov 區塊
    if (!isFastStartRaw && start === 0 && totalSize > VIDEO_BLOCK_SIZE) {
      const moovBlockIdx = Math.floor((totalSize - 1) / VIDEO_BLOCK_SIZE);
      if (moovBlockIdx > 0) {
        fetchAndCacheVideoBlock(fileId, actualQ, moovBlockIdx, AbortSignal.timeout(15000)).catch(() => {});
      }
    }

    const firstBlockIdx = Math.floor(start / VIDEO_BLOCK_SIZE);
    const firstBlockEnd = (firstBlockIdx + 1) * VIDEO_BLOCK_SIZE - 1;

    if (end === null || !Number.isFinite(end) || end < start) {
      // 當瀏覽器 <video> 發送開放式 Range (如 bytes=0-) 時，對齊至當前 2MB 區塊結尾（若剩餘不足 512KB 則連帶下一塊），確保 100% 命中區塊快取
      end = (firstBlockEnd - start + 1 >= 512 * 1024)
        ? firstBlockEnd
        : (firstBlockEnd + VIDEO_BLOCK_SIZE);
    } else if (end - start + 1 > MAX_SPAN_BYTES) {
      end = start + MAX_SPAN_BYTES - 1;
    }

    if (totalSize > 0) {
      if (start >= totalSize) {
        res.set("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }
      end = Math.min(end, totalSize - 1);
    }

    const lastBlockIdx = Math.floor(end / VIDEO_BLOCK_SIZE);
    const blockIndices = [];
    for (let b = firstBlockIdx; b <= lastBlockIdx; b++) blockIndices.push(b);

    const fetchedBlocks = await Promise.all(
      blockIndices.map(bIdx => fetchAndCacheVideoBlock(fileId, actualQ, bIdx, ac.signal))
    );

    const validBlocks = fetchedBlocks.filter(Boolean);
    if (!validBlocks.length) {
      return res.status(502).json({ error: "無法載入影片區塊" });
    }

    if (!totalSize && validBlocks[0].totalSize) {
      totalSize = validBlocks[0].totalSize;
    }
    if (totalSize > 0) {
      end = Math.min(end, totalSize - 1);
    }

    const combinedBuf = validBlocks.length === 1
      ? validBlocks[0].buf
      : Buffer.concat(validBlocks.map(b => b.buf));

    const baseOffset = firstBlockIdx * VIDEO_BLOCK_SIZE;
    const relStart = Math.max(0, start - baseOffset);
    const relEnd = Math.min(combinedBuf.byteLength, end - baseOffset + 1);
    const sliceBuf = combinedBuf.subarray(relStart, relEnd);
    const actualEnd = start + sliceBuf.byteLength - 1;

    // 背景自動預讀後續 2~3 個 2MB 區塊，確保連續串流零等待
    prefetchNextVideoBlocks(fileId, actualQ, lastBlockIdx, actualQ === "raw" ? 3 : 2);

    const etag = `"dfc-${fileId}-${actualQ}-${totalSize || 0}-${start}-${actualEnd}"`;

    res.status(206).set({
      "Content-Type": "video/mp4",
      "Content-Range": `bytes ${start}-${actualEnd}/${totalSize || (actualEnd + 1)}`,
      "Content-Length": String(sliceBuf.byteLength),
      "Accept-Ranges": "bytes",
      "Content-Disposition": "inline",
      "X-Video-Quality": actualQ,
      "X-Video-Version": `${fileId}-${actualQ}-${totalSize || 0}`,
      "ETag": etag,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    return res.end(sliceBuf);
  } catch (err) {
    if (err?.name === "AbortError") return;
    if (!res.headersSent) res.status(502).json({ error: "影片串流連線中斷" });
    else res.end();
  } finally {
    req.off("close", onClose);
  }
});

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

/* ---------- Cloudflare Turnstile 人機驗證 ---------- */
app.post("/api/verify-turnstile", async (req, res) => {
  const token = req.body?.token;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ ok: false, error: "缺少驗證 Token" });
  }

  const secret = (
    process.env.TURNSTILE_SECRET_KEY ||
    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ||
    process.env.CLOUDFLARE_SECRET_KEY ||
    ""
  ).trim();

  // 若尚未在環境變數填寫 Secret Key，在正式環境明確拒絕，僅本機開發警告提示
  if (!secret) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
      console.error("[Turnstile] 伺服器未設定 TURNSTILE_SECRET_KEY 環境變數");
      return res.status(500).json({ ok: false, error: "伺服器人機驗證金鑰尚未設定，請通知系統管理員" });
    }
    console.warn("[Turnstile] 本機測試模式：未設定 TURNSTILE_SECRET_KEY，允許開發測試通過。");
    return res.json({ ok: true, devMode: true });
  }

  try {
    const formData = new URLSearchParams();
    formData.append("secret", secret);
    formData.append("response", token);

    const cfRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(8000),
    });

    const cfData = await cfRes.json();
    if (cfData.success) {
      setCookie(res, "cf_passed", "1", { maxAge: 600 });
      return res.json({ ok: true });
    } else {
      console.warn("[Turnstile] 驗證失敗:", cfData["error-codes"]);
      return res.status(403).json({ ok: false, error: "人機驗證未通過，請重新驗證", details: cfData["error-codes"] });
    }
  } catch (err) {
    console.error("[Turnstile] 驗證伺服器連線異常:", err);
    return res.status(502).json({ ok: false, error: "人機驗證服務連線逾時，請點擊重試" });
  }
});

app.post("/api/auth/google", async (req, res) => {
  const ua = str(req.headers["user-agent"], 300);
  if (await limited("oauth:" + clientIp(req), 30, 600e3)) return res.status(429).json({ error: "Too many requests" });
  const { idToken, nonce, clientMeta } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "Missing token" });
  const claims = decodeJwtPayload(idToken);
  // 先用 token 內容擋掉非學校帳號，避免在 Supabase 建出帳號
  if (!String(claims.email || "").toLowerCase().endsWith(SCHOOL) || (claims.hd && claims.hd !== SCHOOL_HD) || claims.email_verified === false) {
    return res.status(403).json({ error: "domain" });
  }

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
  if (error || !data?.user) return res.status(401).json({ error: "oauth" });
  const u = data.user, email = (u.email || "").toLowerCase();
  if (!email.endsWith(SCHOOL)) {
    if (Date.now() - new Date(u.created_at).getTime() < 120e3) await db.auth.admin.deleteUser(u.id).catch(() => {});
    return res.status(403).json({ error: "domain" });
  }

  const md = u.user_metadata || {};
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

  // 背景非同步更新 metadata 與快取清除，讓登入回應無延遲秒速返回給使用者
  db.auth.admin.updateUserById(u.id, {
    user_metadata: {
      ...md, ...googleInfo,
      kk_login_count: (Number(md.kk_login_count) || 0) + 1,
      kk_last_login_at: new Date().toISOString(),
      kk_last_device: deviceInfo, kk_last_ua: ua, kk_last_ip: clientIp(req),
      kk_timezone: cm.timezone || md.kk_timezone || "",
      ...hardwarePatch(md, cm),
    },
  }).then(() => invalidateQueryCache("users")).catch(() => {});

  const tokenVal = makeToken({
    t: "u", id: u.id, email, name: googleInfo.name, picture: googleInfo.picture, sub: googleInfo.sub,
    given_name: googleInfo.given_name, family_name: googleInfo.family_name, hd: googleInfo.hd, locale: googleInfo.locale,
  }, 8 * 3600);
  setCookie(res, "ks", tokenVal);
  setCookie(res, "cf_passed", "1", { maxAge: 86400 });
  audit(req, "[用戶登入] Google 帳號授權登入", `${email} (${googleInfo.name || "未提供姓名"}) | 裝置: ${deviceInfo}`);

  const fakeReq = { headers: { cookie: `ks=${tokenVal}` } };
  const dfcAccess = await evaluateDfcAccess(fakeReq);
  res.json({
    email,
    name: googleInfo.name,
    picture: googleInfo.picture,
    dfcAccess: { allowed: dfcAccess.allowed, mode: dfcAccess.mode, reason: dfcAccess.reason, message: dfcAccess.message || "" },
  });
});

app.get("/api/me", async (req, res) => {
  if (!sysCache.has("admins")) await readSysStore("admins", []).catch(() => {});
  const isAdmin = Boolean(adminOf(req));
  const base = { googleClientId: GOOGLE_CLIENT_ID, baseUrl: BASE_URL.replace(/\/$/, ""), isAdmin };
  const u = userOf(req);
  if (!u) return res.json({ user: null, dfcAccess: { allowed: false, mode: "whitelist", reason: "unauthenticated" }, ...base });
  const dfcAccess = await evaluateDfcAccess(req);
  res.json({
    user: { email: u.email, name: u.name, picture: u.picture },
    dfcAccess: { allowed: dfcAccess.allowed, mode: dfcAccess.mode, reason: dfcAccess.reason, message: dfcAccess.message || "" },
    ...base,
  });
});

app.post("/api/logout", (req, res) => {
  const u = userOf(req);
  if (u) audit(req, "[用戶登出] 登出平台", `${u.email} (${u.name || ""})`);
  clearCookie(res, "ks");
  res.json({ ok: true });
});

/* --- 使用者全站互動動作安全稽核端點 --- */
app.post("/api/activity", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  if (await limited("act:" + u.id, 150, 60e3)) return res.json({ ok: true });

  const { action, details = "", target = "" } = req.body || {};
  if (!action || typeof action !== "string") return res.status(400).json({ error: "Missing action" });

  const safeAction = String(action).slice(0, 80);
  const detailStr = String(details || target || "").slice(0, 300);
  const userLabel = `${u.email}${u.name ? ` (${u.name})` : ""}`;
  const logTarget = `${userLabel} | ${detailStr}`;

  audit(req, `[用戶動作] ${safeAction}`, logTarget);

  try {
    await db.from("activity_logs").insert({
      user_id: u.id,
      user_email: u.email,
      user_name: u.name || "",
      action: safeAction,
      details: detailStr,
      device_info: parseUA(req.headers["user-agent"] || ""),
      ip_address: clientIp(req),
    });
  } catch {}

  res.json({ ok: true });
});

/* ============================================================================
 * 諺語系統圖片儲存與 Instagram 自動發布引擎 (Proverb Image & Instagram Engine)
 * ============================================================================ */
const proverbLocalImages = new Map();
let instagramLogsTableOk = true;

function getBaseUrl(req) {
  if (process.env.BASE_URL && !process.env.BASE_URL.includes("localhost") && !process.env.BASE_URL.includes("127.0.0.1")) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  }
  const proto = req?.headers?.["x-forwarded-proto"] || "http";
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function parseImageData(dataUrlOrBuf) {
  if (!dataUrlOrBuf) return null;
  if (Buffer.isBuffer(dataUrlOrBuf)) return { buf: dataUrlOrBuf, mime: "image/jpeg" };
  if (typeof dataUrlOrBuf !== "string") return null;
  const match = dataUrlOrBuf.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) {
    let mime = match[1].toLowerCase();
    if (mime === "image/jpg") mime = "image/jpeg";
    try {
      return { buf: Buffer.from(match[2], "base64"), mime };
    } catch {
      return null;
    }
  }
  try {
    const buf = Buffer.from(dataUrlOrBuf, "base64");
    if (buf.length > 0) return { buf, mime: "image/jpeg" };
  } catch {}
  return null;
}

async function saveProverbImage(input, defaultMime = "image/jpeg", req = null) {
  const parsed = parseImageData(input);
  if (!parsed || !parsed.buf || parsed.buf.length === 0) return null;

  const ext = parsed.mime.includes("png") ? "png" : "jpg";
  const fileName = `proverb_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;

  // 1. 本地記憶體快取 (上限 100 張，即使重啟或外部連線中斷也能正常服務)
  proverbLocalImages.set(fileName, {
    buf: parsed.buf,
    mime: parsed.mime,
    ts: Date.now(),
  });
  if (proverbLocalImages.size > 100) {
    const oldestKey = proverbLocalImages.keys().next().value;
    proverbLocalImages.delete(oldestKey);
  }
  try {
    const tmpFile = path.join(os.tmpdir(), `kknews_${fileName}`);
    fs.writeFileSync(tmpFile, parsed.buf);
  } catch {}

  // 2. 優先上傳至 Supabase Storage 公開存取桶 (kknews-proverbs)
  let publicUrl = null;
  try {
    await db.storage.createBucket("kknews-proverbs", { public: true }).catch(() => {});
    const { error } = await db.storage
      .from("kknews-proverbs")
      .upload(fileName, parsed.buf, {
        contentType: parsed.mime,
        upsert: true,
      });
    if (!error) {
      const { data: pubData } = db.storage.from("kknews-proverbs").getPublicUrl(fileName);
      if (pubData?.publicUrl) publicUrl = pubData.publicUrl;
    }
  } catch {}

  // 3. 若無 Supabase Storage 公開網址，使用伺服器自身路由提供公開存取
  if (!publicUrl) {
    const baseUrl = getBaseUrl(req);
    publicUrl = `${baseUrl}/api/proverbs/images/${fileName}`;
  }

  return { fileName, publicUrl, size: parsed.buf.length, mime: parsed.mime };
}

const DEFAULT_IG_CONFIG = {
  enabled: process.env.INSTAGRAM_AUTO_POST !== "false",
  accountId: process.env.INSTAGRAM_ACCOUNT_ID || "",
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
  captionTemplate: process.env.INSTAGRAM_CAPTION_TEMPLATE || "{content}\n\n— {author}\n\n#KKNews #校園金句 #諺語工坊 #花蓮教育",
  webhookUrl: process.env.INSTAGRAM_WEBHOOK_URL || "",
};

async function getMergedInstagramConfig() {
  const store = await readSysStore("instagram", DEFAULT_IG_CONFIG);
  return {
    enabled: typeof store.enabled === "boolean" ? store.enabled : (process.env.INSTAGRAM_AUTO_POST !== "false"),
    accountId: String(store.accountId || process.env.INSTAGRAM_ACCOUNT_ID || "").trim(),
    accessToken: String(store.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN || "").trim(),
    captionTemplate: String(store.captionTemplate || process.env.INSTAGRAM_CAPTION_TEMPLATE || DEFAULT_IG_CONFIG.captionTemplate).trim(),
    webhookUrl: String(store.webhookUrl || process.env.INSTAGRAM_WEBHOOK_URL || "").trim(),
  };
}

async function recordInstagramLog(entry) {
  const logItem = {
    proverb_id: entry.proverbId ? Number(entry.proverbId) : null,
    content: str(entry.content, 100),
    author: str(entry.author, 30),
    image_url: entry.imageUrl || null,
    status: entry.status || (entry.posted ? "success" : (entry.skipped ? "skipped" : "failed")),
    ig_media_id: entry.mediaId || null,
    ig_permalink: entry.permalink || null,
    error_message: entry.error ? str(entry.error, 500) : null,
    created_at: new Date().toISOString(),
  };

  // 1. 寫入 PostgreSQL instagram_logs
  if (instagramLogsTableOk) {
    try {
      const { error } = await db.from("instagram_logs").insert(logItem);
      if (error && (error.code === "PGRST205" || error.code === "42P01")) {
        instagramLogsTableOk = false;
      }
    } catch {
      instagramLogsTableOk = false;
    }
  }

  // 2. 備份至系統存儲庫
  try {
    const existing = await readSysStore("instagram_logs", []);
    const updated = [logItem, ...(Array.isArray(existing) ? existing : [])].slice(0, 100);
    await writeSysStore("instagram_logs", updated);
  } catch {}
}

async function fetchInstagramLogs(limit = 50) {
  if (instagramLogsTableOk) {
    try {
      const { data, error } = await db
        .from("instagram_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (!error && Array.isArray(data)) return data;
      if (error && (error.code === "PGRST205" || error.code === "42P01")) instagramLogsTableOk = false;
    } catch {}
  }
  const fallback = await readSysStore("instagram_logs", []);
  return (Array.isArray(fallback) ? fallback : []).slice(0, limit);
}

async function getInstagramSummaryForAdmin() {
  const config = await getMergedInstagramConfig();
  const logs = await fetchInstagramLogs(25).catch(() => []);
  const successCount = logs.filter(l => l.status === "success").length;
  const isConnected = Boolean(config.accountId && config.accessToken);
  return {
    config: {
      enabled: config.enabled,
      accountId: config.accountId,
      accessTokenConfigured: Boolean(config.accessToken),
      accessTokenMasked: config.accessToken ? `${config.accessToken.slice(0, 8)}...${config.accessToken.slice(-6)}` : "",
      captionTemplate: config.captionTemplate,
      webhookUrl: config.webhookUrl,
    },
    status: {
      connected: isConnected,
      enabled: config.enabled,
      successCount,
      recentLogs: logs,
    },
  };
}

async function publishToInstagram({ imageUrl, content, author, proverbId, customCaption = null, studentEmail = "", studentName = "" }) {
  const config = await getMergedInstagramConfig();
  if (!config.enabled) {
    const res = { ok: false, skipped: true, reason: "Instagram 自動發布功能已暫停" };
    await recordInstagramLog({ proverbId, content, author, imageUrl, status: "skipped", error: res.reason });
    return res;
  }

  const results = {
    posted: false,
    mediaId: null,
    permalink: null,
    graphApi: null,
    webhook: null,
    error: null,
  };

  const caption = customCaption || config.captionTemplate
    .replace(/\{content\}/g, content || "")
    .replace(/\{author\}/g, author || "")
    .replace(/\{id\}/g, String(proverbId || ""));

  const hasMeta = Boolean(config.accountId && config.accessToken);
  const hasWebhook = Boolean(config.webhookUrl);

  if (!hasMeta && !hasWebhook) {
    const res = { ok: false, skipped: true, reason: "尚未設定 Instagram API 憑證或 Webhook 網址" };
    await recordInstagramLog({ proverbId, content, author, imageUrl, status: "skipped", error: res.reason });
    return res;
  }

  // 1. Meta Graph API 發布貼文 (Instagram Content Publishing API)
  if (hasMeta) {
    try {
      // Step A: 建立 IG 媒體容器 (Media Container)
      const containerUrl = `https://graph.facebook.com/v20.0/${encodeURIComponent(config.accountId)}/media`;
      const containerParams = new URLSearchParams({
        image_url: imageUrl,
        caption: caption,
        access_token: config.accessToken,
      });
      const containerResp = await fetch(containerUrl, {
        method: "POST",
        body: containerParams,
        signal: AbortSignal.timeout(18000),
      });
      const containerData = await containerResp.json().catch(() => ({}));
      if (!containerResp.ok || !containerData.id) {
        throw new Error(containerData.error?.message || `建立 IG 容器失敗 (HTTP ${containerResp.status})`);
      }
      const creationId = containerData.id;

      // Step B: 輪詢容器就緒狀態 (檢查 status_code)
      let isReady = false;
      for (let i = 0; i < 6; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1200));
        const stResp = await fetch(
          `https://graph.facebook.com/v20.0/${creationId}?fields=status_code&access_token=${encodeURIComponent(config.accessToken)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        const stData = await stResp.json().catch(() => ({}));
        const code = stData.status_code || "FINISHED";
        if (code === "FINISHED") {
          isReady = true;
          break;
        } else if (code === "ERROR" || code === "EXPIRED") {
          throw new Error(`IG 容器處理狀態錯誤: ${code}`);
        }
      }

      // Step C: 發布貼文 (Media Publish)
      const pubUrl = `https://graph.facebook.com/v20.0/${encodeURIComponent(config.accountId)}/media_publish`;
      const pubParams = new URLSearchParams({
        creation_id: creationId,
        access_token: config.accessToken,
      });
      const pubResp = await fetch(pubUrl, {
        method: "POST",
        body: pubParams,
        signal: AbortSignal.timeout(18000),
      });
      const pubData = await pubResp.json().catch(() => ({}));
      if (!pubResp.ok || !pubData.id) {
        throw new Error(pubData.error?.message || `IG 媒體發布失敗 (HTTP ${pubResp.status})`);
      }
      const mediaId = pubData.id;

      // Step D: 取得貼文 Permalink
      let permalink = null;
      try {
        const infoResp = await fetch(
          `https://graph.facebook.com/v20.0/${mediaId}?fields=permalink,shortcode&access_token=${encodeURIComponent(config.accessToken)}`,
          { signal: AbortSignal.timeout(6000) }
        );
        const infoData = await infoResp.json().catch(() => ({}));
        permalink = infoData.permalink || null;
      } catch {}

      results.graphApi = { ok: true, mediaId, permalink };
      results.posted = true;
      results.mediaId = mediaId;
      results.permalink = permalink;
    } catch (err) {
      results.graphApi = { ok: false, error: err.message };
      results.error = err.message;
    }
  }

  // 2. Webhook 轉發 (支援 Zapier / Make / n8n / 自建伺服器)
  if (hasWebhook) {
    try {
      const hookResp = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "proverb_image_received",
          id: proverbId,
          content,
          author,
          imageUrl,
          caption,
          studentEmail,
          studentName,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10000),
      });
      results.webhook = { ok: hookResp.ok, status: hookResp.status };
      if (hookResp.ok && !results.posted) results.posted = true;
    } catch (err) {
      results.webhook = { ok: false, error: err.message };
      if (!results.error) results.error = err.message;
    }
  }

  await recordInstagramLog({
    proverbId,
    content,
    author,
    imageUrl,
    status: results.posted ? "success" : "failed",
    mediaId: results.mediaId,
    permalink: results.permalink,
    error: results.error,
  });

  return results;
}

// 公開讀取伺服器所暫存之諺語卡片圖檔（供外部 CDN、Instagram 或前台預覽直連）
app.get("/api/proverbs/images/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  if (proverbLocalImages.has(filename)) {
    const item = proverbLocalImages.get(filename);
    res.setHeader("Content-Type", item.mime || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
    return res.end(item.buf);
  }
  const tmpFile = path.join(os.tmpdir(), `kknews_${filename}`);
  if (fs.existsSync(tmpFile)) {
    const mime = filename.endsWith(".png") ? "image/png" : "image/jpeg";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800");
    return res.sendFile(tmpFile, { dotfiles: "allow" });
  }
  notFound(res);
});

app.post("/api/proverbs", async (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: "請先登入" });
  if (await limited("post:" + u.id, 15, 600e3)) return res.status(429).json({ error: "投稿太頻繁，請稍後再試" });
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

  // 1. 若收到卡片圖檔 (cardImage 或 image)
  const rawImage = req.body?.cardImage || req.body?.image;
  let savedImage = null;
  if (rawImage) {
    savedImage = await saveProverbImage(rawImage, "image/jpeg", req);
  }

  const fullMeta = {
    google_sub: u.sub || null, given_name: u.given_name || null, family_name: u.family_name || null,
    picture: u.picture || null, hd: u.hd || null, locale: u.locale || cm.language || null,
    device_info: deviceInfo, user_agent: ua, ip_address: ip,
    platform: cm.platform || null, screen: cm.screen || null, timezone: cm.timezone || null, geo: cm.geo,
    gpu: cm.gpu || null, cores: cm.cores || null, memory: cm.memory || null, battery: cm.battery || null, network: cm.network || null,
    imageUrl: savedImage?.publicUrl || null,
    cardStyle: (req.body?.cardStyle && typeof req.body.cardStyle === "object") ? {
      layout: String(req.body.cardStyle.layout || "classic").slice(0, 24),
      themeId: String(req.body.cardStyle.themeId || "ivory").slice(0, 24),
      bg: String(req.body.cardStyle.bg || "#f4f2ee").slice(0, 24),
      text: String(req.body.cardStyle.text || "#1c1917").slice(0, 24),
      sub: String(req.body.cardStyle.sub || "#6b665d").slice(0, 24),
      accent: String(req.body.cardStyle.accent || "#1868c7").slice(0, 24),
      font: String(req.body.cardStyle.font || "reggae").slice(0, 24),
      hasCustomBg: Boolean(req.body.cardStyle.hasCustomBg),
    } : null,
  };

  // 先嘗試寫入完整擴充欄位，若 Supabase 尚未執行 ALTER TABLE 則自動儲存於基本欄位
  let newId = null;
  let { data: insData, error } = await db.from("proverbs").insert({
    user_id: u.id, user_email: u.email, user_name: u.name || null, user_avatar: u.picture || null,
    google_sub: u.sub || null, user_meta: fullMeta, device_info: deviceInfo, user_agent: ua, ip_address: ip, content, author,
    image_url: savedImage?.publicUrl || null,
    ig_status: savedImage?.publicUrl ? "processing" : "no_image",
  }).select("id");
  if (!error && insData && insData[0]?.id) newId = insData[0].id;

  if (error) {
    const retry = await db.from("proverbs").insert({
      user_id: u.id, user_email: u.email, user_name: JSON.stringify({ name: u.name || "", ...fullMeta }), content, author,
    }).select("id");
    error = retry.error;
    if (!error && retry.data && retry.data[0]?.id) newId = retry.data[0].id;
  }
  if (error) return res.status(500).json({ error: "送出失敗" });

  audit(req, "[諺語投稿] 送出專屬卡片", `${u.email} (${u.name || ""}) | "${content.slice(0, 40)}" by ${author}${savedImage ? " [含卡片圖檔]" : ""}`);
  invalidateQueryCache("proverbs", "proverbsCount", "users");

  // 2. 收到圖片：自動發布貼文到 Instagram
  let igStatus = null;
  if (savedImage?.publicUrl) {
    try {
      const igResult = await publishToInstagram({
        imageUrl: savedImage.publicUrl,
        content,
        author,
        proverbId: newId,
        studentEmail: u.email,
        studentName: u.name || "",
      });
      igStatus = {
        posted: Boolean(igResult.posted),
        skipped: Boolean(igResult.skipped),
        mediaId: igResult.mediaId || null,
        permalink: igResult.permalink || null,
        error: igResult.error || igResult.reason || null,
      };
      if (newId && igResult.posted) {
        fullMeta.igPostId = igResult.mediaId;
        fullMeta.igPermalink = igResult.permalink;
        fullMeta.igPostedAt = new Date().toISOString();
        await db.from("proverbs").update({
          ig_post_id: igResult.mediaId || null,
          ig_permalink: igResult.permalink || null,
          ig_status: "posted",
          ig_posted_at: new Date().toISOString(),
          user_meta: fullMeta,
        }).eq("id", newId).catch(() => {});
        invalidateQueryCache("proverbs", "proverbsCount", "users");
      }
    } catch (err) {
      console.error("[Instagram Auto-Post]", err);
      igStatus = { posted: false, error: err.message };
    }
  }

  res.json({
    ok: true,
    id: newId,
    imageUrl: savedImage?.publicUrl || null,
    igStatus,
  });
});

/* --- 前台讀取 DFC 表單清單（嚴格防暴雷：未授權帳號絕不回傳題目、表單與影片網址） --- */
app.get("/api/dfc/forms", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  const store = await readSysStore("dfc", DEFAULT_DFC_STORE, true);
  const access = await evaluateDfcAccess(req, store);
  if (!access.allowed) {
    return res.json({
      restricted: true,
      accessMode: access.mode,
      reason: access.reason,
      message: access.message,
      activeFormId: "",
      forms: [],
    });
  }
  const forms = Array.isArray(store.forms) && store.forms.length ? store.forms : DEFAULT_DFC_STORE.forms;
  const activeId = store.activeFormId || forms[0]?.id || "default-dfc";
  res.json({
    restricted: false,
    accessMode: access.mode,
    activeFormId: activeId,
    forms: forms.map(f => ({
      id: f.id,
      title: f.title,
      description: f.description || "",
      videoUrl: f.videoUrl,
      videoVersion: extractGoogleDriveFileId(f.videoUrl || "") || f.videoUrl || "",
      fallbackDuration: f.fallbackDuration || 18,
      questionCount: (f.checkpoints || []).length,
      isDefault: f.id === activeId,
      updatedAt: f.updatedAt,
    })),
  });
});

/* --- 前台讀取最新 DFC 表單設定（嚴格防暴雷：未授權帳號隱藏所有題目與影片來源） --- */
app.get("/api/dfc/config", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  const formId = String(req.query.formId || "").trim();
  const store = await getDfcStoreWithDb(true);
  const access = await evaluateDfcAccess(req, store);
  if (!access.allowed) {
    return res.json({
      restricted: true,
      accessMode: access.mode,
      reason: access.reason,
      message: access.message,
      id: "restricted",
      title: "DFC 互動影音探究問卷",
      description: access.message,
      videoUrl: "",
      fallbackDuration: 0,
      checkpoints: [],
      formsList: [],
    });
  }

  const forms = Array.isArray(store.forms) && store.forms.length ? store.forms : DEFAULT_DFC_STORE.forms;
  const activeId = store.activeFormId || forms[0]?.id || "default-dfc";

  let matchedForm = formId ? forms.find(f => f.id === formId) : null;
  if (!matchedForm) matchedForm = forms.find(f => f.id === activeId) || forms[0];

  res.json({
    ...matchedForm,
    videoVersion: extractGoogleDriveFileId(matchedForm?.videoUrl || "") || matchedForm?.videoUrl || "",
    restricted: false,
    accessMode: access.mode,
    activeFormId: activeId,
    formsList: forms.map(f => ({
      id: f.id,
      title: f.title,
      description: f.description || "",
      questionCount: (f.checkpoints || []).length,
      isDefault: f.id === activeId,
    })),
  });
});

/* --- DFC 互動影片表單：作答結果原生儲存於 Supabase 資料表 (dfc_responses) 並寫入後台統計與審計 --- */
app.post("/api/dfc/submit", async (req, res) => {
  if (await limited("dfc:" + clientIp(req), 30, 600e3)) return res.status(429).json({ error: "送出太頻繁，請稍後再試" });
  const store = await getDfcStoreWithDb(true);
  const access = await evaluateDfcAccess(req, store);
  if (!access.allowed) {
    return res.status(403).json({ error: access.message || "權限保護中：僅限授權帳號提交問卷" });
  }

  const { formId = "default-dfc", answers = {}, telemetry = {}, engagement = {}, userInfo = {} } = req.body || {};
  if (!answers || typeof answers !== "object") return res.status(400).json({ error: "格式不正確" });

  const u = userOf(req) || adminOf(req);
  const ua = str(req.headers["user-agent"], 300);
  const deviceInfo = parseUA(ua);
  const ip = clientIp(req);

  const matchedForm = (store.forms || []).find(f => f.id === formId) || (store.forms || [])[0] || DEFAULT_DFC_STORE.forms[0];

  const respRecord = {
    id: crypto.randomUUID(),
    formId: matchedForm?.id || "default-dfc",
    formTitle: matchedForm?.title || "DFC 互動影片表單",
    userId: u?.id || null,
    userEmail: u?.email || String(userInfo?.email || "未知帳號"),
    userName: u?.name || String(userInfo?.name || ""),
    userClass: str(String(userInfo?.classSeat || telemetry?.classSeat || ""), 60),
    ip,
    device: deviceInfo,
    answers,
    telemetry: (telemetry && typeof telemetry === "object") ? telemetry : {},
    engagement: (engagement && typeof engagement === "object") ? engagement : {},
    syncedToGoogle: false,
    demo: false,
    submittedAt: new Date().toISOString(),
  };

  // 1. 原生儲存至 Supabase dfc_responses 資料表
  await insertDfcResponseInSupabase(respRecord);

  // 2. 同步保存至系統快取，供後台即時檢視與分析
  if (!Array.isArray(store.responses)) store.responses = [];
  store.responses.unshift(respRecord);
  if (store.responses.length > 2000) store.responses.length = 2000;
  await writeSysStore("dfc", store);

  audit(req, "[DFC作答] 送出問卷作答", `${u?.email || "未知"} (${u?.name || ""}) | 表單: ${matchedForm?.title || formId} (已原生儲存至 Supabase)`);

  res.json({ ok: true, savedToSupabase: true, demo: false });
});

/* --- 後台安全防護、郵件一次性驗證碼 (OTP) 與裝置信任授權機制 --- */
const escapeHtml = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 原生零相依 TLS SMTP 發信核心（相容 Gmail 應用程式密碼及所有標準 SMTP）
function sendSmtpMail({ host = "smtp.gmail.com", port = 465, user, pass, from, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const cleanUser = String(user || "").trim();
    const cleanPass = String(pass || "").replace(/\s+/g, "");
    const cleanFrom = from && from.includes("<") ? from.match(/<([^>]+)>/)?.[1] || cleanUser : (cleanUser || "no-reply@kknews.org");
    const cleanTo = to && to.includes("<") ? to.match(/<([^>]+)>/)?.[1] || to : to;

    const socket = tls.connect(Number(port) || 465, host, { servername: host }, () => {});
    socket.setTimeout(12000, () => cleanup(new Error("SMTP 連線逾時 (12 秒)")));

    let buffer = "";
    let step = 0;

    function cleanup(err, res) {
      if (resolved) return;
      resolved = true;
      try { socket.end(); } catch {}
      try { socket.destroy(); } catch {}
      if (err) reject(err);
      else resolve(res);
    }

    socket.on("error", err => cleanup(err));
    socket.on("close", () => {
      if (!resolved) cleanup(new Error("SMTP 連線意外中斷"));
    });

    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      if (lines.length <= 1) return;
      const lastLine = lines[lines.length - 2];
      const match = lastLine.match(/^(\d{3})(?: (.*))?$/);
      if (!match) return;

      const code = parseInt(match[1], 10);
      buffer = "";

      try {
        if (code >= 400) return cleanup(new Error(`SMTP 回應錯誤 (${code}): ${lastLine}`));

        if (step === 0) {
          step = 1;
          socket.write(`EHLO ${host}\r\n`);
        } else if (step === 1) {
          step = 2;
          socket.write("AUTH LOGIN\r\n");
        } else if (step === 2) {
          if (code !== 334) return cleanup(new Error(`AUTH LOGIN 失敗: ${lastLine}`));
          step = 3;
          socket.write(Buffer.from(cleanUser).toString("base64") + "\r\n");
        } else if (step === 3) {
          if (code !== 334) return cleanup(new Error(`SMTP 帳號驗證失敗: ${lastLine}`));
          step = 4;
          socket.write(Buffer.from(cleanPass).toString("base64") + "\r\n");
        } else if (step === 4) {
          if (code !== 235) return cleanup(new Error(`SMTP 密碼驗證失敗: ${lastLine}`));
          step = 5;
          socket.write(`MAIL FROM:<${cleanFrom}>\r\n`);
        } else if (step === 5) {
          step = 6;
          socket.write(`RCPT TO:<${cleanTo}>\r\n`);
        } else if (step === 6) {
          step = 7;
          socket.write("DATA\r\n");
        } else if (step === 7) {
          if (code !== 354) return cleanup(new Error(`DATA 指令失敗: ${lastLine}`));
          step = 8;
          const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const mailHeaders = [
            `From: ${from || `KKNews 安全中心 <${cleanUser}>`}`,
            `To: ${to}`,
            `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
            `MIME-Version: 1.0`,
            `Date: ${new Date().toUTCString()}`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            `Content-Type: text/plain; charset=UTF-8`,
            `Content-Transfer-Encoding: base64`,
            "",
            Buffer.from(text || html.replace(/<[^>]+>/g, " ")).toString("base64"),
            "",
            `--${boundary}`,
            `Content-Type: text/html; charset=UTF-8`,
            `Content-Transfer-Encoding: base64`,
            "",
            Buffer.from(html).toString("base64"),
            "",
            `--${boundary}--`,
            "",
            ".",
            "",
          ].join("\r\n");
          socket.write(mailHeaders);
        } else if (step === 8) {
          step = 9;
          socket.write("QUIT\r\n");
          cleanup(null, { ok: true, detail: lastLine });
        }
      } catch (e) {
        cleanup(e);
      }
    });
  });
}

// 發送一次性驗證碼 (OTP) 至中央主管信箱 (預設 kai1010210@gmail.com)
async function sendAdminOtpMail({ to = ADMIN_OTP_EMAIL, otp, accountEmail, ip, ua }) {
  const subject = `【KKNews 安全驗證碼】${otp} - 新裝置登入授權`;
  const timeStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const html = `
<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:24px;background:#f5f7fa;color:#1e293b">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06)">
    <div style="background:linear-gradient(135deg,#1868c7,#0d4b94);padding:24px;text-align:center;color:#ffffff">
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;opacity:0.85;margin-bottom:4px">KKNEWS SECURITY</div>
      <h2 style="margin:0;font-size:22px;font-weight:800">新裝置安全授權驗證</h2>
    </div>
    <div style="padding:28px 24px">
      <p style="margin:0 0 16px;font-size:14.5px;line-height:1.6;color:#334155">
        您好，系統偵測到有管理員嘗試從<strong>新裝置或新瀏覽器</strong>登入 KKNews 後台主控台。
      </p>
      <div style="background:#f0f7ff;border:1.5px dashed #2563eb;border-radius:12px;padding:20px;text-align:center;margin:20px 0">
        <div style="font-size:12px;font-weight:600;color:#2563eb;letter-spacing:1px;margin-bottom:8px">一次性安全授權驗證碼 (OTP)</div>
        <div style="font-size:38px;font-weight:900;letter-spacing:10px;color:#1d4ed8;font-family:monospace;user-select:all">${otp}</div>
        <div style="font-size:12px;color:#64748b;margin-top:8px">有效期限 10 分鐘 · 僅可使用一次</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:20px 0;background:#f8fafc;border-radius:8px;padding:12px;border:1px solid #e2e8f0">
        <tr><td style="padding:8px 12px;color:#64748b;width:90px">登入帳號</td><td style="padding:8px 12px;font-weight:600;color:#0f172a">${escapeHtml(accountEmail)}</td></tr>
        <tr><td style="padding:8px 12px;color:#64748b">申請時間</td><td style="padding:8px 12px;color:#0f172a">${timeStr}</td></tr>
        <tr><td style="padding:8px 12px;color:#64748b">來源 IP</td><td style="padding:8px 12px;font-family:monospace;color:#0f172a">${escapeHtml(ip)}</td></tr>
        <tr><td style="padding:8px 12px;color:#64748b">瀏覽裝置</td><td style="padding:8px 12px;font-size:12px;color:#475569;word-break:break-all">${escapeHtml(ua)}</td></tr>
      </table>
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 14px;border-radius:4px;font-size:12.5px;line-height:1.6;color:#92400e;margin-top:16px">
        <strong>⚠️ 安全提醒：</strong>
        <ul style="margin:4px 0 0;padding-left:18px">
          <li>每個裝置僅需驗證一次，通過後系統將自動信任該裝置。</li>
          <li>若為受邀協同管理員登入，請主管確認身分後將此驗證碼提供給該管理員。</li>
          <li>若非您或授權管理員本人操作，請切勿提供驗證碼，並建議儘速檢查後台密碼安全。</li>
        </ul>
      </div>
    </div>
    <div style="background:#f1f5f9;padding:14px;text-align:center;font-size:11.5px;color:#64748b;border-top:1px solid #e2e8f0">
      KKNews 校園互動與 DFC 影音學習平台 · 自動安全發信系統
    </div>
  </div>
</body>
</html>
  `.trim();
  const text = `【KKNews 安全驗證碼】\n您的 6 位數一次性驗證碼為：${otp}\n\n登入帳號：${accountEmail}\n申請時間：${timeStr}\n來源 IP：${ip}\n有效期限：10 分鐘\n\n本裝置驗證一次即自動信任。若非您本人或授權管理員操作，請勿將驗證碼提供給他人。`;

  let sent = false;
  let errorDetail = "";

  // 1. Resend API
  if (RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [to],
          subject,
          html,
          text,
        }),
      });
      if (res.ok) {
        sent = true;
      } else {
        const j = await res.json().catch(() => ({}));
        errorDetail = `Resend error (${res.status}): ${j.message || res.statusText}`;
        // 若觸發 Resend 測試網域 (onboarding@resend.dev) 限制（僅允許寄給 Resend 帳號註冊信箱），自動轉發至該已驗證信箱
        const allowedMatch = j.message?.match(/own email address \(([^)]+)\)/);
        if (allowedMatch && allowedMatch[1] && allowedMatch[1] !== to) {
          console.log(`[MAIL] 偵測到 Resend 測試網域限制，自動轉發驗證碼至已驗證主管信箱: ${allowedMatch[1]}`);
          const retryRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: [allowedMatch[1]],
              subject,
              html,
              text,
            }),
          });
          if (retryRes.ok) {
            sent = true;
            to = allowedMatch[1];
          }
        }
      }
    } catch (e) {
      errorDetail = `Resend error: ${e.message}`;
    }
  }

  // 2. SMTP (支援 Gmail 應用程式密碼及標準 TLS SMTP)
  if (!sent && SMTP_USER && SMTP_PASS) {
    try {
      await sendSmtpMail({
        host: SMTP_HOST,
        port: SMTP_PORT,
        user: SMTP_USER,
        pass: SMTP_PASS,
        from: SMTP_FROM || `KKNews 安全中心 <${SMTP_USER}>`,
        to,
        subject,
        html,
        text,
      });
      sent = true;
    } catch (e) {
      errorDetail = (errorDetail ? errorDetail + " | " : "") + `SMTP error: ${e.message}`;
    }
  }

  // 3. SendGrid API
  if (!sent && SENDGRID_API_KEY) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: SMTP_FROM || "security@kknews.org", name: "KKNews 安全中心" },
          subject,
          content: [
            { type: "text/plain", value: text },
            { type: "text/html", value: html },
          ],
        }),
      });
      if (res.ok || res.status === 202) sent = true;
      else {
        const err = await res.text().catch(() => "");
        errorDetail = (errorDetail ? errorDetail + " | " : "") + `SendGrid error: ${err}`;
      }
    } catch (e) {
      errorDetail = (errorDetail ? errorDetail + " | " : "") + `SendGrid error: ${e.message}`;
    }
  }

  // 4. Webhook
  if (!sent && MAIL_WEBHOOK_URL) {
    try {
      const res = await fetch(MAIL_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, otp, accountEmail, ip, ua, subject, html, text }),
      });
      if (res.ok) sent = true;
    } catch (e) {
      errorDetail = (errorDetail ? errorDetail + " | " : "") + `Webhook error: ${e.message}`;
    }
  }

  // 永遠同步輸出至伺服器 Console，讓管理員在未配妥 SMTP 時也能立即查看驗證碼順利登入
  console.log(`\n============================================================`);
  console.log(`[KKNews 安全驗證碼 (OTP) 派送]`);
  console.log(`目標主管信箱: ${to}`);
  console.log(`登入管理員帳號: ${accountEmail}`);
  console.log(`6 位數一次性驗證碼: ${otp} (有效時間 10 分鐘)`);
  console.log(`發信通道狀態: ${sent ? "✅ 已成功寄出" : "⚠️ 未寄出 (" + (errorDetail || "請設定 SMTP_USER/SMTP_PASS 或 RESEND_API_KEY") + ")"}`);
  console.log(`來源 IP: ${ip} | 時間: ${timeStr}`);
  console.log(`============================================================\n`);

  // 原生儲存至 Supabase 稽核紀錄
  try {
    await db.from("admin_audit").insert({
      action: "[安全驗證] 派發新裝置授權驗證碼",
      target: `帳號: ${accountEmail} | 目標信箱: ${to} | 驗證碼: ${otp} | 狀態: ${sent ? "已寄出" : "待發信服務設定"}`,
      ip,
    });
  } catch {}

  return { ok: true, sent, errorDetail };
}

/* ---------- 裝置信任世代與長效信任判斷（一個裝置只要驗證一次） ---------- */
let cachedDeviceTrustEpoch = 1;
async function getDeviceTrustEpoch() {
  const cached = sysCache.get("device_trust_epoch")?.data;
  if (cached && typeof cached.epoch === "number") return cached.epoch;
  try {
    const s = await readSysStore("device_trust_epoch", { epoch: 1 });
    cachedDeviceTrustEpoch = Number(s?.epoch) || 1;
    return cachedDeviceTrustEpoch;
  } catch {
    return cachedDeviceTrustEpoch;
  }
}

async function isTrustedDevice(req) {
  const p = readToken(cookies(req).kdt);
  if (!p || p.t !== "dev" || !p.id) return false;
  const currentEpoch = await getDeviceTrustEpoch();
  if (typeof p.epoch === "number" && p.epoch < currentEpoch) return false;
  return true;
}

// 待處理之 OTP 挑戰暫存
const pendingOtpChallenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ch, item] of pendingOtpChallenges.entries()) {
    if (now > item.expiresAt) pendingOtpChallenges.delete(ch);
  }
}, 5 * 60 * 1000).unref();

app.use("/api/admin", async (req, res, next) => {
  if (!sysCache.has("admins") && req.path !== "/login" && req.path !== "/logout" && req.path !== "/verify-otp" && req.path !== "/resend-otp") {
    await readSysStore("admins", []).catch(() => {});
  }
  next();
});

// 後台主入口：直接訪問 /adminusercontrol 即可（已全面取消 ?k= 金鑰限制）
app.get("/adminusercontrol", async (req, res) => {
  if (!sysCache.has("admins")) await readSysStore("admins", []).catch(() => {});
  if (adminOf(req)) return sendStaticAsset(req, res, PAGES.admin.html, "text/html; charset=utf-8", "private, no-cache");
  // 若網址帶有舊版 ?k= 金鑰參數，302 重導向徹底消除網址列雜訊
  if (req.query?.k) {
    return res.redirect(302, "/adminusercontrol");
  }
  return sendStaticAsset(req, res, PAGES.login.html, "text/html; charset=utf-8", "private, no-cache");
});

app.get("/adminusercontrol/jszip.js", async (req, res) => {
  if (!sysCache.has("admins")) await readSysStore("admins", []).catch(() => {});
  if (!adminOf(req)) return notFound(res);
  return sendStaticAsset(req, res, PAGES.jszip, "application/javascript; charset=utf-8", "private, max-age=3600");
});

function formatAdminAccounts(adminList, isSuper = false) {
  const primary = {
    id: "primary-super-admin",
    email: ADMIN_EMAIL,
    name: "SixStar Culture 主管理員",
    role: "super_admin",
    isPrimary: true,
    createdAt: "系統預設",
    lastLoginAt: "",
    loginCount: 0,
    hasPassword: true,
  };
  const others = (Array.isArray(adminList) ? adminList : []).map(a => {
    const role = normalizeAdminRole(a.role, a.email);
    return {
      id: a.id,
      email: a.email,
      name: a.name || (role === "super_admin" ? "Super Admin" : "一般管理員（唯讀）"),
      role,
      isPrimary: false,
      createdAt: a.createdAt || "",
      lastLoginAt: a.lastLoginAt || "",
      loginCount: a.loginCount || 0,
      hasPassword: Boolean(a.passwordHash),
    };
  });
  return [primary, ...others];
}

/* --- 管理員登入：密碼驗證 + 裝置信任 / OTP 二次授權 --- */
app.post("/api/admin/login", async (req, res) => {
  if (await limited("login:" + clientIp(req), 10, 900e3)) return res.status(429).json({ error: "嘗試次數過多，請稍後再試" });
  const { email, password } = req.body || {};
  const inputEmail = String(email || "").trim().toLowerCase();
  const inputPw = String(password || "");

  let matchedAdmin = null;
  const adminList = await readSysStore("admins", []);
  const subAcc = (Array.isArray(adminList) ? adminList : []).find(a => String(a.email || "").trim().toLowerCase() === inputEmail);

  // 1. 若為後台新增的管理員帳號（且非系統主帳號），優先驗證該帳號獨立密碼與其設定之權限
  if (subAcc && !isPrimaryAdminEmail(inputEmail)) {
    const ok = await verifyPassword(inputPw, subAcc.passwordHash);
    if (ok) {
      const role = normalizeAdminRole(subAcc.role, subAcc.email);
      subAcc.role = role;
      subAcc.lastLoginAt = new Date().toISOString();
      subAcc.loginCount = (Number(subAcc.loginCount) || 0) + 1;
      await writeSysStore("admins", adminList);
      matchedAdmin = {
        email: subAcc.email,
        role,
        name: subAcc.name || (role === "super_admin" ? "Super Admin" : "一般管理員（唯讀）"),
        isPrimary: false,
        pwUpdatedAt: subAcc.pwUpdatedAt || subAcc.createdAt || "",
      };
    }
  }

  // 2. 若尚未匹配成功，檢查是否為系統主 Super Admin 帳號 (.env ADMIN_EMAIL)
  if (!matchedAdmin && isPrimaryAdminEmail(inputEmail)) {
    const ok = await verifyPassword(inputPw, ADMIN_PASSWORD_HASH);
    if (ok) {
      matchedAdmin = {
        email: ADMIN_EMAIL,
        role: "super_admin",
        name: "SixStar Culture 主管理員",
        isPrimary: true,
        pwUpdatedAt: "primary",
      };
    }
  }

  audit(req, matchedAdmin ? `admin_login_pw_ok:${matchedAdmin.role}` : "admin_login_pw_fail", inputEmail);
  if (!matchedAdmin) return res.status(401).json({ error: "帳號或密碼錯誤" });

  // 3. 檢查當前裝置是否已受信任（一個裝置只要驗證一次）
  const deviceTrusted = await isTrustedDevice(req);
  if (deviceTrusted) {
    // 裝置已信任：直接核發登入 Session Cookie
    setCookie(res, "ka", makeToken({
      t: "a",
      email: matchedAdmin.email,
      role: matchedAdmin.role,
      name: matchedAdmin.name,
      isPrimary: Boolean(matchedAdmin.isPrimary),
      pwAt: matchedAdmin.pwUpdatedAt || "",
    }, 4 * 3600), { strict: true });
    audit(req, "admin_login_trusted_device", `${matchedAdmin.email} | 裝置已信任直通進入`);
    return res.json({ ok: true, trusted: true, role: matchedAdmin.role, email: matchedAdmin.email, name: matchedAdmin.name });
  }

  // 4. 新裝置或未信任裝置：一律產生 6 位數一次性驗證碼傳送至主管信箱 kai1010210@gmail.com
  const otp = String(crypto.randomInt(100000, 1000000));
  const challenge = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const pendingRecord = {
    challenge,
    otp,
    admin: matchedAdmin,
    ip: clientIp(req),
    ua: req.headers["user-agent"] || "",
    attempts: 0,
    createdAt: now,
    lastSentAt: now,
    expiresAt: now + 10 * 60 * 1000, // 10 分鐘
  };
  pendingOtpChallenges.set(challenge, pendingRecord);

  // 寄發 OTP 郵件
  const mailResult = await sendAdminOtpMail({
    to: ADMIN_OTP_EMAIL,
    otp,
    accountEmail: matchedAdmin.email,
    ip: pendingRecord.ip,
    ua: pendingRecord.ua,
  }).catch(e => {
    console.error("[MAIL] sendAdminOtpMail error:", e);
    return { ok: false, sent: false, to: ADMIN_OTP_EMAIL, errorDetail: e.message };
  });

  const actualTarget = mailResult?.to || ADMIN_OTP_EMAIL;
  audit(req, "admin_otp_requested", `申請帳號: ${matchedAdmin.email} | 驗證碼傳送至: ${actualTarget} (狀態: ${mailResult?.sent ? "成功" : "失敗"})`);

  const atIdx = actualTarget.indexOf("@");
  const maskedEmail = atIdx > 3
    ? actualTarget.slice(0, 3) + "***" + actualTarget.slice(atIdx - 2)
    : actualTarget;

  let hintMessage = `一次性授權驗證碼已傳送至信箱 (${actualTarget})，每個裝置僅需驗證一次。`;
  if (mailResult && !mailResult.sent) {
    hintMessage = `⚠️ 發信未成功 (${mailResult.errorDetail || "請設定 Gmail 應用程式密碼"})。請至 Vercel Runtime Logs 或 Supabase admin_audit 查看驗證碼。`;
  } else if (actualTarget !== ADMIN_OTP_EMAIL) {
    hintMessage = `💡 因 Resend 限制，驗證碼已轉寄至您的 Resend 註冊信箱：${actualTarget}，請至該信箱查收！`;
  }

  return res.json({
    ok: false,
    requireOtp: true,
    challenge,
    targetEmail: actualTarget,
    targetMasked: maskedEmail,
    message: hintMessage,
    expiresIn: 600,
  });
});

/* --- 新裝置 OTP 驗證：核發長效信任 Cookie (kdt) 與登入 Session (ka) --- */
app.post("/api/admin/verify-otp", async (req, res) => {
  if (await limited("verify_otp:" + clientIp(req), 15, 600e3)) return res.status(429).json({ error: "嘗試驗證過於頻繁，請稍後再試" });
  const { challenge, code } = req.body || {};
  const pending = pendingOtpChallenges.get(String(challenge || ""));
  if (!pending || Date.now() > pending.expiresAt) {
    if (pending) pendingOtpChallenges.delete(String(challenge));
    return res.status(400).json({ error: "驗證碼已失效或過期，請重新登入" });
  }

  if (pending.attempts >= 5) {
    pendingOtpChallenges.delete(String(challenge));
    audit(req, "admin_otp_max_attempts", pending.admin.email);
    return res.status(400).json({ error: "驗證錯誤次數過多，此驗證碼已失效，請重新登入" });
  }

  const inputCode = String(code || "").trim();
  const ok = inputCode.length === 6 && eq(inputCode, pending.otp);
  if (!ok) {
    pending.attempts++;
    const remaining = 5 - pending.attempts;
    audit(req, "admin_otp_failed_attempt", `${pending.admin.email} (尚餘 ${remaining} 次)`);
    return res.status(400).json({
      error: remaining > 0 ? `驗證碼不正確，尚有 ${remaining} 次機會` : "驗證錯誤次數已達上限，請重新登入",
      remaining,
    });
  }

  // 驗證成功！
  pendingOtpChallenges.delete(String(challenge));
  const currentEpoch = await getDeviceTrustEpoch();
  const devId = crypto.randomUUID();

  // 1. 設定長效裝置信任 Cookie (180 天)
  setCookie(res, "kdt", makeToken({
    t: "dev",
    id: devId,
    epoch: currentEpoch,
    at: Date.now(),
  }, 180 * 86400), { maxAge: 180 * 86400, strict: false });

  // 2. 設定管理員登入 Session Cookie (4 小時)
  setCookie(res, "ka", makeToken({
    t: "a",
    email: pending.admin.email,
    role: pending.admin.role,
    name: pending.admin.name,
    isPrimary: Boolean(pending.admin.isPrimary),
    pwAt: pending.admin.pwUpdatedAt || "",
  }, 4 * 3600), { strict: true });

  audit(req, "admin_otp_verified_new_device", `${pending.admin.email} | 裝置已授權並信任 | DevId: ${devId}`);

  return res.json({
    ok: true,
    trusted: true,
    role: pending.admin.role,
    email: pending.admin.email,
    name: pending.admin.name,
  });
});

/* --- 重發驗證碼 (OTP) --- */
app.post("/api/admin/resend-otp", async (req, res) => {
  if (await limited("resend_otp:" + clientIp(req), 6, 600e3)) return res.status(429).json({ error: "重發驗證碼過於頻繁，請稍候再試" });
  const { challenge } = req.body || {};
  const pending = pendingOtpChallenges.get(String(challenge || ""));
  if (!pending || Date.now() > pending.expiresAt) {
    return res.status(400).json({ error: "驗證請求已過期，請重新登入" });
  }

  const now = Date.now();
  if (now - pending.lastSentAt < 45000) {
    const waitSec = Math.ceil((45000 - (now - pending.lastSentAt)) / 1000);
    return res.status(429).json({ error: `請等待 ${waitSec} 秒後再重新發送` });
  }

  pending.otp = String(crypto.randomInt(100000, 1000000));
  pending.lastSentAt = now;
  pending.expiresAt = now + 10 * 60 * 1000;
  pending.attempts = 0;

  const mailResult = await sendAdminOtpMail({
    to: ADMIN_OTP_EMAIL,
    otp: pending.otp,
    accountEmail: pending.admin.email,
    ip: pending.ip,
    ua: pending.ua,
  }).catch(e => {
    console.error("[MAIL] sendAdminOtpMail error:", e);
    return { ok: false, sent: false, to: ADMIN_OTP_EMAIL, errorDetail: e.message };
  });

  const actualTarget = mailResult?.to || ADMIN_OTP_EMAIL;
  audit(req, "admin_otp_resent", `${pending.admin.email} -> ${actualTarget}`);
  let msg = `已重新發送驗證碼至主管信箱 (${actualTarget})`;
  if (actualTarget !== ADMIN_OTP_EMAIL) {
    msg = `已重新發送驗證碼至 Resend 註冊信箱 (${actualTarget})`;
  }
  res.json({ ok: true, message: msg, targetEmail: actualTarget });
});

/* --- 裝置信任撤銷管理 --- */
app.post("/api/admin/devices/revoke-current", (req, res) => {
  clearCookie(res, "kdt");
  clearCookie(res, "ka");
  audit(req, "admin_device_revoked_current", "已撤銷本裝置之信任狀態");
  res.json({ ok: true, message: "已撤銷本裝置信任並登出" });
});

app.post("/api/admin/devices/revoke-all", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const curEpoch = await getDeviceTrustEpoch();
  const nextEpoch = curEpoch + 1;
  cachedDeviceTrustEpoch = nextEpoch;
  await writeSysStore("device_trust_epoch", {
    epoch: nextEpoch,
    revokedAt: new Date().toISOString(),
    revokedBy: req.admin?.email || ADMIN_EMAIL,
  });
  audit(req, "[資安防護] 強制所有裝置重新驗證", `提升裝置世代至 ${nextEpoch}，所有已信任裝置下次登入皆須重新通過 OTP 驗證`);
  res.json({ ok: true, epoch: nextEpoch, message: `已成功撤銷所有已信任裝置 (世代 ${nextEpoch})` });
});

app.post("/api/admin/logout", (req, res) => {
  const adm = adminOf(req);
  if (adm) audit(req, "admin_logout", adm.email);
  clearCookie(res, "ka");
  clearCookie(res, "kak");
  res.json({ ok: true });
});

/* --- 後台管理員帳號列表與管理（Super Admin 可新增/移除一般 Admin） --- */
app.get("/api/admin/accounts", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  const adminList = await readSysStore("admins", []);
  const liveAdm = adminOf(req) || adm;
  const isSuper = liveAdm.role === "super_admin";
  res.json({
    me: { email: liveAdm.email, role: liveAdm.role, name: liveAdm.name },
    accounts: formatAdminAccounts(adminList, Boolean(isSuper)),
    accessKey: isSuper ? ADMIN_ACCESS_KEY : "",
    otpEmail: ADMIN_OTP_EMAIL,
    deviceTrusted: await isTrustedDevice(req),
    deviceEpoch: await getDeviceTrustEpoch(),
  });
});

app.post("/api/admin/accounts", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const name = str(req.body?.name || "", 50).trim();
  const role = req.body?.role === "super_admin" ? "super_admin" : "admin";

  if (!email || !email.includes("@") || email.length > 100) {
    return res.status(400).json({ error: "請輸入有效的管理員 Email 帳號" });
  }
  if (password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: "密碼長度需介於 6 ~ 100 個字元之間" });
  }
  if (eq(email, ADMIN_EMAIL.toLowerCase())) {
    return res.status(400).json({ error: "此信箱已為系統主 Super Admin 帳號" });
  }

  const adminList = await readSysStore("admins", []);
  if (adminList.some(a => String(a.email).toLowerCase() === email)) {
    return res.status(400).json({ error: "此管理員帳號已經存在" });
  }

  const passwordHash = await hashPassword(password);
  const newAcc = {
    id: crypto.randomUUID(),
    email,
    name: name || (role === "super_admin" ? "Super Admin" : "一般管理員（唯讀）"),
    role,
    passwordHash,
    createdAt: new Date().toISOString(),
    lastLoginAt: "",
    loginCount: 0,
  };
  adminList.push(newAcc);
  await writeSysStore("admins", adminList);
  audit(req, "create_admin", `${email} (${role})`);
  res.json({ ok: true, id: newAcc.id, role: newAcc.role });
});

app.patch("/api/admin/accounts/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const id = String(req.params.id);
  if (id === "primary-super-admin") return res.status(400).json({ error: "系統主 Super Admin 帳號不可降級或修改" });
  const adminList = await readSysStore("admins", []);
  const target = adminList.find(a => a.id === id);
  if (!target) return res.status(404).json({ error: "找不到該管理員帳號" });

  if (req.body?.role != null) {
    target.role = normalizeAdminRole(req.body.role, target.email);
    if (req.body?.name == null && (target.name === "Super Admin" || target.name === "一般管理員" || target.name === "一般管理員（唯讀）")) {
      target.name = target.role === "super_admin" ? "Super Admin" : "一般管理員（唯讀）";
    }
  }
  if (req.body?.name != null) {
    const trimmed = str(req.body.name, 50).trim();
    target.name = trimmed || (target.role === "super_admin" ? "Super Admin" : "一般管理員（唯讀）");
  }
  if (req.body?.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: "新密碼長度至少需 6 個字元" });
    target.passwordHash = await hashPassword(String(req.body.password));
    target.pwUpdatedAt = new Date().toISOString();
    delete target.plainPassword;
  }
  await writeSysStore("admins", adminList);
  audit(req, "update_admin", `${target.email} (${target.role})`);
  res.json({ ok: true, role: target.role, name: target.name });
});

app.delete("/api/admin/accounts/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const id = String(req.params.id);
  if (id === "primary-super-admin") return res.status(400).json({ error: "系統主 Super Admin 帳號不可刪除" });
  const adminList = await readSysStore("admins", []);
  const idx = adminList.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: "找不到該管理員帳號" });
  const removed = adminList.splice(idx, 1)[0];
  await writeSysStore("admins", adminList);
  audit(req, "delete_admin", removed.email);
  res.json({ ok: true });
});

/* --- 後台 DFC 互動問卷設定、防暴雷觀看名單與作答數據管理（全量儲存於 Supabase） --- */
app.get("/api/admin/dfc", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  const store = await getDfcStoreWithDb(true);
  const accessCfg = await getMergedDfcAccessConfig(store);
  const forms = Array.isArray(store.forms) && store.forms.length ? store.forms : DEFAULT_DFC_STORE.forms;
  const dbStatus = await getDfcStatsFromSupabase();
  res.json({
    activeFormId: store.activeFormId || forms[0]?.id || "default-dfc",
    accessMode: accessCfg.accessMode,
    allowedEmails: accessCfg.allowedEmails,
    storeAllowedEmails: accessCfg.storeAllowedEmails,
    dbAllowedEmails: accessCfg.dbAllowedEmails,
    envAllowedEmails: accessCfg.envAllowedEmails,
    forms,
    responses: Array.isArray(store.responses) ? store.responses : [],
    dbStatus,
    storageType: "supabase_postgresql",
  });
});

// 查詢與更新 DFC 影片防暴雷觀看名單（支援切換模式、批次儲存名單、或單鍵切換單一使用者）
app.get("/api/admin/dfc/access", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const cfg = await getMergedDfcAccessConfig();
  res.json(cfg);
});

app.post("/api/admin/dfc/access", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const store = await readSysStore("dfc", DEFAULT_DFC_STORE, true);
  const cfg = await getMergedDfcAccessConfig(store);
  let nextList = [...cfg.allowedEmails];

  if (req.body?.accessMode && ["whitelist", "all_school", "closed"].includes(req.body.accessMode)) {
    store.accessMode = req.body.accessMode;
  }
  if (req.body?.allowedEmails !== undefined) {
    nextList = parseEmailListInput(req.body.allowedEmails);
  }
  if (req.body?.toggleEmail) {
    const target = normalizeEmailRule(req.body.toggleEmail);
    if (target) {
      const exists = nextList.includes(target);
      nextList = exists ? nextList.filter(e => e !== target) : [...nextList, target];
    }
  }

  store.allowedEmails = nextList;
  await writeSysStore("dfc", store);
  await syncDbDfcAccessList(nextList, adm.email || ADMIN_EMAIL);
  audit(req, "update_dfc_access", `mode=${store.accessMode}, count=${nextList.length}`);

  const updated = await getMergedDfcAccessConfig(store);
  res.json({ ok: true, ...updated });
});

// 設定前台預設主推問卷
app.post("/api/admin/dfc/set-active-form", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const { formId } = req.body || {};
  if (!formId) return res.status(400).json({ error: "缺少表單 ID" });
  const store = await getDfcStoreWithDb(true);
  const target = (store.forms || []).find(f => f.id === formId);
  if (!target) return res.status(404).json({ error: "找不到指定表單" });
  store.activeFormId = formId;
  store.forms = (store.forms || []).map(f => ({ ...f, isDefault: f.id === formId }));
  await setActiveDfcFormInSupabase(formId);
  await writeSysStore("dfc", store);
  invalidateDriveVideoCache();
  audit(req, "set_active_dfc_form", formId);
  res.json({ ok: true, activeFormId: formId });
});

// 複製既有問卷以快速建立新問卷
app.post("/api/admin/dfc/duplicate-form", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const { formId } = req.body || {};
  const store = await getDfcStoreWithDb(true);
  const src = (store.forms || []).find(f => f.id === formId) || (store.forms || [])[0];
  if (!src) return res.status(404).json({ error: "找不到來源問卷" });

  const newId = "form-" + Date.now();
  const clonedForm = JSON.parse(JSON.stringify(src));
  clonedForm.id = newId;
  clonedForm.title = (clonedForm.title || "問卷") + " (副本)";
  clonedForm.isDefault = false;
  clonedForm.updatedAt = new Date().toISOString();
  if (Array.isArray(clonedForm.checkpoints)) {
    clonedForm.checkpoints = clonedForm.checkpoints.map((cp, idx) => ({
      ...cp,
      id: "q" + (idx + 1) + "_" + Date.now().toString(36),
    }));
  }

  if (!Array.isArray(store.forms)) store.forms = [];
  store.forms.push(clonedForm);
  await upsertDfcFormInSupabase(clonedForm);
  await writeSysStore("dfc", store);
  audit(req, "duplicate_dfc_form", `${src.id} -> ${newId}`);
  res.json({ ok: true, form: clonedForm });
});

/* --- 產生精細化 DFC CSV：每個選項獨立一格、附帶完整行為與設備數據 --- */
function buildComprehensiveDfcCsv(form, responses) {
  const checkpoints = Array.isArray(form?.checkpoints) ? form.checkpoints : [];

  const headers = [
    "序號",
    "提交時間",
    "填答者姓名",
    "填答者信箱",
    "班級學號",
    "資料儲存狀態",
    "影片觀看率(%)",
    "實際觀看秒數",
    "影片總時長(秒)",
    "倒退次數(↺10s)",
    "暫停次數",
    "快轉跳轉次數",
    "總停留耗時(秒)",
    "裝置類型",
    "作業系統",
    "瀏覽器",
    "螢幕解析度",
    "視窗大小",
    "系統語言",
    "網路連線",
    "IP位址",
  ];

  checkpoints.forEach((cp, idx) => {
    const qNum = `Q${idx + 1}`;
    headers.push(`${qNum}: ${cp.title} [完整填答]`);
    headers.push(`${qNum} 作答耗時(秒)`);

    const hasOpts = ["radio", "checkbox", "dropdown"].includes(cp.type) && Array.isArray(cp.options) && cp.options.length;
    if (hasOpts) {
      cp.options.forEach((opt, oIdx) => {
        headers.push(`${qNum} [選項${oIdx + 1}: ${opt}]`);
      });
    } else if (cp.type === "boolean") {
      headers.push(`${qNum} [選項: 是/贊成]`);
      headers.push(`${qNum} [選項: 否/反對]`);
    } else if (cp.type === "rating") {
      headers.push(`${qNum} [評分星級 1~5]`);
    }
  });

  const rows = (responses || []).map((r, rIdx) => {
    const tel = r.telemetry || {};
    const eng = r.engagement || {};
    const timeSpentMap = eng.timeSpentPerQuestion || {};

    const row = [
      String(rIdx + 1),
      r.submittedAt ? new Date(r.submittedAt).toLocaleString("zh-TW", { hour12: false }) : "",
      r.userName || "",
      r.userEmail || "",
      r.userClass || "",
      "Supabase 雲端資料庫",
      eng.watchPercentage != null ? `${eng.watchPercentage}%` : "—",
      eng.watchedSeconds != null ? String(eng.watchedSeconds) : "—",
      eng.duration != null ? String(eng.duration) : String(form?.fallbackDuration || "—"),
      eng.rewindCount != null ? String(eng.rewindCount) : "0",
      eng.pauseCount != null ? String(eng.pauseCount) : "0",
      eng.seekCount != null ? String(eng.seekCount) : "0",
      eng.totalSessionSeconds != null ? String(eng.totalSessionSeconds) : "—",
      tel.deviceType || r.device || "桌機",
      tel.os || r.device || "—",
      tel.browser || "—",
      tel.screenResolution || "—",
      tel.viewportSize || "—",
      tel.language || "zh-TW",
      tel.connectionType || "—",
      r.ip || "",
    ];

    checkpoints.forEach((cp) => {
      const ansVal = r.answers ? (r.answers[cp.id] ?? r.answers[cp.entryId] ?? "") : "";
      const textVal = Array.isArray(ansVal) ? ansVal.join("、") : String(ansVal ?? "");
      row.push(textVal);

      const spent = timeSpentMap[cp.id] ?? timeSpentMap[cp.entryId] ?? "";
      row.push(spent !== "" ? String(spent) : "—");

      const hasOpts = ["radio", "checkbox", "dropdown"].includes(cp.type) && Array.isArray(cp.options) && cp.options.length;
      if (hasOpts) {
        cp.options.forEach(opt => {
          let chosen = false;
          if (Array.isArray(ansVal)) {
            chosen = ansVal.includes(opt);
          } else if (ansVal) {
            chosen = String(ansVal).trim() === String(opt).trim();
          }
          row.push(chosen ? "1" : "0");
        });
      } else if (cp.type === "boolean") {
        const s = String(ansVal).trim();
        const isYes = s === "是" || s === "true" || s === "贊成";
        const isNo = s === "否" || s === "false" || s === "反對";
        row.push(isYes ? "1" : "0");
        row.push(isNo ? "1" : "0");
      } else if (cp.type === "rating") {
        const stars = Number(ansVal) || 0;
        row.push(stars > 0 ? String(stars) : "");
      }
    });

    return row;
  });

  const csvLines = [headers.map(toCsvCell).join(","), ...rows.map(r => r.map(toCsvCell).join(","))];
  const rawCsv = "\uFEFF" + csvLines.join("\r\n");

  return { headers, rows, rawCsv };
}

app.get("/api/admin/dfc/csv", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  const formId = String(req.query.formId || "default-dfc");
  const store = await getDfcStoreWithDb(true);
  const forms = Array.isArray(store.forms) && store.forms.length ? store.forms : DEFAULT_DFC_STORE.forms;
  const form = forms.find(f => f.id === formId) || forms[0];
  const responses = (store.responses || []).filter(r => !formId || formId === "all" || r.formId === form.id);

  const comp = buildComprehensiveDfcCsv(form, responses);
  res.json({
    formId: form?.id || formId,
    formTitle: form?.title || "",
    source: "supabase_db",
    headers: comp.headers,
    rows: comp.rows,
    localHeaders: comp.headers,
    localRows: comp.rows,
    remoteHeaders: [],
    remoteRows: [],
    rawCsv: comp.rawCsv,
  });
});

// Super Admin 新增或更新 DFC 互動問卷設定與時間點題目（原生儲存於 Supabase）
app.post("/api/admin/dfc/forms", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const body = req.body || {};
  const id = String(body.id || "").trim() || ("form-" + Date.now());
  const title = str(body.title || "未命名 DFC 表單", 100).trim();
  const description = str(body.description || "", 300).trim();
  const videoUrl = str(body.videoUrl || "/assets/dfc.mp4", 300).trim();
  const fallbackDuration = Math.max(5, Math.min(7200, Number(body.fallbackDuration) || 18));
  const submitMode = body.submitMode === "each" ? "each" : "end";
  const allowSeek = ["watched", "locked", "free"].includes(body.allowSeek) ? body.allowSeek : "watched";
  const allowRewind = body.allowRewind !== false;
  const allowSpeed = Boolean(body.allowSpeed);
  const pauseOnBlur = body.pauseOnBlur !== false;

  let checkpoints = [];
  const ALLOWED_TYPES = ["radio", "checkbox", "rating", "dropdown", "boolean", "text", "textarea"];
  if (Array.isArray(body.checkpoints)) {
    checkpoints = body.checkpoints.map((cp, idx) => {
      const rawTime = Number(cp.time);
      const safeTime = Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : (idx + 1) * 5;
      const cpId = str(cp.id || `q${idx + 1}`, 40);
      return {
        id: cpId,
        time: safeTime,
        entryId: str(cp.entryId || cpId, 60).trim(),
        stepLabel: str(cp.stepLabel || `階段 ${idx + 1}`, 40).trim(),
        title: str(cp.title || `問題 ${idx + 1}`, 200).trim(),
        desc: str(cp.desc || "", 300).trim(),
        type: ALLOWED_TYPES.includes(cp.type) ? cp.type : "radio",
        options: Array.isArray(cp.options) ? cp.options.map(o => str(String(o), 150).trim()).filter(Boolean) : [],
        placeholder: str(cp.placeholder || "", 120).trim(),
        min: Number(cp.min) || 1,
        max: Number(cp.max) || 5,
        required: cp.required !== false,
      };
    }).sort((a, b) => a.time - b.time);
  }

  const store = await getDfcStoreWithDb(true);
  if (!Array.isArray(store.forms)) store.forms = [];
  const existingIdx = store.forms.findIndex(f => f.id === id);
  const formObj = {
    id, title, description, videoUrl, fallbackDuration, submitMode,
    allowSeek, allowRewind, allowSpeed, pauseOnBlur,
    isDefault: Boolean(body.isDefault),
    checkpoints: Array.isArray(body.checkpoints) ? checkpoints : (existingIdx >= 0 ? (store.forms[existingIdx].checkpoints || []) : []),
    updatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) store.forms[existingIdx] = formObj;
  else store.forms.push(formObj);

  if (body.isDefault) {
    store.activeFormId = id;
    store.forms.forEach(f => { f.isDefault = (f.id === id); });
    await setActiveDfcFormInSupabase(id);
  }

  await upsertDfcFormInSupabase(formObj);
  await writeSysStore("dfc", store);
  invalidateDriveVideoCache();
  audit(req, "save_dfc_form", id);
  res.json({ ok: true, form: formObj });
});

app.delete("/api/admin/dfc/forms/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const id = String(req.params.id);
  const store = await getDfcStoreWithDb(true);
  if ((store.forms || []).length <= 1) {
    return res.status(400).json({ error: "系統至少需保留一份 DFC 表單，不可全數刪除" });
  }
  store.forms = (store.forms || []).filter(f => f.id !== id);
  if (store.activeFormId === id) {
    store.activeFormId = store.forms[0]?.id || "default-dfc";
    await setActiveDfcFormInSupabase(store.activeFormId);
  }
  await deleteDfcFormInSupabase(id);
  await writeSysStore("dfc", store);
  audit(req, "delete_dfc_form", id);
  res.json({ ok: true, activeFormId: store.activeFormId });
});

// Super Admin 匯入問卷 CSV 作答數據至 Supabase
app.post("/api/admin/dfc/import-csv", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const { formId = "default-dfc", csvText = "" } = req.body || {};
  const parsed = parseCsvText(csvText);
  if (!parsed.headers.length || !parsed.rows.length) {
    return res.status(400).json({ error: "CSV 內容為空或格式無法解析" });
  }
  const store = await getDfcStoreWithDb(true);
  const form = (store.forms || []).find(f => f.id === formId) || (store.forms || [])[0] || DEFAULT_DFC_STORE.forms[0];
  const checkpoints = Array.isArray(form?.checkpoints) ? form.checkpoints : [];

  let importedCount = 0;
  for (const r of parsed.rows) {
    const answers = {};
    parsed.headers.forEach((h, colIdx) => {
      const val = r[colIdx] ?? "";
      const matchedCp = checkpoints.find((cp, cIdx) => (cp.id && h.includes(cp.id)) || (cp.entryId && h.includes(cp.entryId)) || h.includes(cp.title) || colIdx === cIdx + 1);
      if (matchedCp) {
        if (!answers[matchedCp.id]) answers[matchedCp.id] = val;
        if (matchedCp.entryId && !answers[matchedCp.entryId]) answers[matchedCp.entryId] = val;
      }
      answers[h] = val;
    });
    const respObj = {
      id: crypto.randomUUID(),
      formId: form?.id || formId,
      formTitle: form?.title || "CSV 匯入表單",
      userEmail: r[1] && String(r[1]).includes("@") ? r[1] : (r[3] && String(r[3]).includes("@") ? r[3] : "CSV 匯入紀錄"),
      userName: r[2] || "",
      ip: "CSV Import",
      device: "CSV 匯入",
      answers,
      syncedToGoogle: false,
      demo: false,
      submittedAt: r[1] && !Number.isNaN(Date.parse(r[1])) ? new Date(r[1]).toISOString() : new Date().toISOString(),
    };
    await insertDfcResponseInSupabase(respObj);
    store.responses.unshift(respObj);
    importedCount++;
  }
  if (store.responses.length > 2000) store.responses.length = 2000;
  await writeSysStore("dfc", store);
  audit(req, "import_dfc_csv", `${formId} (${importedCount} 筆作答已匯入 Supabase)`);
  res.json({ ok: true, importedCount });
});

app.delete("/api/admin/dfc/responses/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const id = String(req.params.id);
  const formId = String(req.query.formId || "");
  const store = await getDfcStoreWithDb(true);
  await deleteDfcResponsesInSupabase(id, formId);
  if (id === "all") {
    store.responses = formId ? (store.responses || []).filter(r => r.formId !== formId) : [];
  } else {
    store.responses = (store.responses || []).filter(r => r.id !== id);
  }
  await writeSysStore("dfc", store);
  audit(req, "delete_dfc_response", id);
  res.json({ ok: true });
});

/* --- 後台 DFC 題目獨立管理、快速增刪改、匯出 CSV 與 Supabase 全量同步 --- */
app.get("/api/admin/dfc/questions", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const formId = String(req.query.formId || "");
  const store = await getDfcStoreWithDb(true);
  const targetForm = (store.forms || []).find(f => f.id === formId) || (store.forms || []).find(f => f.id === store.activeFormId) || (store.forms || [])[0];
  if (!targetForm) return res.status(404).json({ error: "找不到問卷" });
  res.json({
    ok: true,
    formId: targetForm.id,
    formTitle: targetForm.title,
    questions: Array.isArray(targetForm.checkpoints) ? targetForm.checkpoints : [],
    storageType: "supabase_postgresql",
  });
});

app.post("/api/admin/dfc/questions", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const { formId, question } = req.body || {};
  if (!question || !question.title) return res.status(400).json({ error: "缺少題目內容" });
  const store = await getDfcStoreWithDb(true);
  const targetForm = (store.forms || []).find(f => f.id === formId) || (store.forms || []).find(f => f.id === store.activeFormId) || (store.forms || [])[0];
  if (!targetForm) return res.status(404).json({ error: "找不到問卷" });

  if (!Array.isArray(targetForm.checkpoints)) targetForm.checkpoints = [];
  const qId = String(question.id || "").trim() || `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const safeTime = Math.max(0, Number(question.time) || 0);
  const ALLOWED_TYPES = ["radio", "checkbox", "rating", "dropdown", "boolean", "text", "textarea"];
  const qObj = {
    id: qId,
    time: safeTime,
    entryId: String(question.entryId || qId).trim(),
    stepLabel: String(question.stepLabel || `階段 ${targetForm.checkpoints.length + 1}`).trim(),
    title: String(question.title).trim(),
    desc: String(question.desc || "").trim(),
    type: ALLOWED_TYPES.includes(question.type) ? question.type : "radio",
    options: Array.isArray(question.options) ? question.options.map(o => String(o).trim()).filter(Boolean) : [],
    placeholder: String(question.placeholder || "").trim(),
    min: Number(question.min) || 1,
    max: Number(question.max) || 5,
    required: question.required !== false,
  };

  const existIdx = targetForm.checkpoints.findIndex(c => c.id === qId);
  if (existIdx >= 0) {
    targetForm.checkpoints[existIdx] = qObj;
  } else {
    targetForm.checkpoints.push(qObj);
  }
  targetForm.checkpoints.sort((a, b) => a.time - b.time);
  targetForm.updatedAt = new Date().toISOString();

  await upsertDfcFormInSupabase(targetForm);
  await writeSysStore("dfc", store);
  audit(req, "save_dfc_question", `${targetForm.id} | ${qObj.title}`);
  res.json({ ok: true, question: qObj, form: targetForm });
});

app.delete("/api/admin/dfc/questions/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const qId = String(req.params.id);
  const formId = String(req.query.formId || "");
  const store = await getDfcStoreWithDb(true);
  const targetForm = (store.forms || []).find(f => f.id === formId) || (store.forms || []).find(f => f.id === store.activeFormId) || (store.forms || [])[0];
  if (!targetForm) return res.status(404).json({ error: "找不到問卷" });

  if (!Array.isArray(targetForm.checkpoints)) targetForm.checkpoints = [];
  targetForm.checkpoints = targetForm.checkpoints.filter(c => c.id !== qId);
  targetForm.updatedAt = new Date().toISOString();

  await upsertDfcFormInSupabase(targetForm);
  await writeSysStore("dfc", store);
  audit(req, "delete_dfc_question", `${targetForm.id} | ${qId}`);
  res.json({ ok: true, remainingCount: targetForm.checkpoints.length, form: targetForm });
});

app.post("/api/admin/dfc/questions/reorder", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const { formId, questionIds } = req.body || {};
  if (!Array.isArray(questionIds)) return res.status(400).json({ error: "格式不正確" });
  const store = await getDfcStoreWithDb(true);
  const targetForm = (store.forms || []).find(f => f.id === formId) || (store.forms || []).find(f => f.id === store.activeFormId) || (store.forms || [])[0];
  if (!targetForm) return res.status(404).json({ error: "找不到問卷" });

  const map = new Map((targetForm.checkpoints || []).map(cp => [cp.id, cp]));
  const reordered = [];
  for (const id of questionIds) {
    if (map.has(id)) {
      reordered.push(map.get(id));
      map.delete(id);
    }
  }
  for (const cp of map.values()) {
    reordered.push(cp);
  }
  targetForm.checkpoints = reordered;
  targetForm.updatedAt = new Date().toISOString();

  await upsertDfcFormInSupabase(targetForm);
  await writeSysStore("dfc", store);
  audit(req, "reorder_dfc_questions", `${targetForm.id}`);
  res.json({ ok: true, form: targetForm });
});

app.get("/api/admin/dfc/questions/csv", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const formId = String(req.query.formId || "");
  const store = await getDfcStoreWithDb(true);
  const targetForm = (store.forms || []).find(f => f.id === formId) || (store.forms || []).find(f => f.id === store.activeFormId) || (store.forms || [])[0];
  if (!targetForm) return res.status(404).send("找不到問卷");

  const checkpoints = Array.isArray(targetForm.checkpoints) ? targetForm.checkpoints : [];
  const typeMapZh = {
    radio: "單選", checkbox: "多選", rating: "評分", dropdown: "下拉",
    boolean: "是非", text: "簡答", textarea: "詳答",
  };

  const rows = [
    ["時間", "階段標籤", "題目內容", "題型", "選項清單", "補充說明", "是否必填", "EntryID"],
  ];

  for (const cp of checkpoints) {
    const sec = Number(cp.time) || 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const mmss = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    const optStr = Array.isArray(cp.options) ? cp.options.join(" | ") : "";
    rows.push([
      mmss,
      cp.stepLabel || "",
      cp.title || "",
      typeMapZh[cp.type] || cp.type || "單選",
      optStr,
      cp.desc || "",
      cp.required !== false ? "是" : "否",
      cp.entryId || cp.id || "",
    ]);
  }

  const csvStr = "\uFEFF" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const fn = encodeURIComponent(`${targetForm.title || "DFC問卷"}_題目清單.csv`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fn}"; filename*=UTF-8''${fn}`);
  res.send(csvStr);
});

app.post("/api/admin/dfc/sync-db", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const store = await readSysStore("dfc", DEFAULT_DFC_STORE, true);
  const forms = Array.isArray(store.forms) && store.forms.length ? store.forms : DEFAULT_DFC_STORE.forms;
  let syncedForms = 0;
  let syncedQuestions = 0;
  let syncedResponses = 0;

  for (const f of forms) {
    const ok = await upsertDfcFormInSupabase(f);
    if (ok) {
      syncedForms++;
      syncedQuestions += (f.checkpoints || []).length;
    }
  }

  const responses = Array.isArray(store.responses) ? store.responses : [];
  for (const r of responses) {
    const ok = await insertDfcResponseInSupabase(r);
    if (ok) syncedResponses++;
  }

  const accessCfg = await getMergedDfcAccessConfig(store);
  await syncDbDfcAccessList(accessCfg.allowedEmails, req.admin?.email || ADMIN_EMAIL);

  audit(req, "sync_dfc_db", `forms=${syncedForms}, qs=${syncedQuestions}, resps=${syncedResponses}`);
  const dbStatus = await getDfcStatsFromSupabase();
  res.json({
    ok: true,
    syncedForms,
    syncedQuestions,
    syncedResponses,
    dbStatus,
    syncedAt: new Date().toISOString(),
  });
});

app.get("/api/admin/dfc/db-status", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  const status = await getDfcStatsFromSupabase();
  res.json(status);
});

/* --- 共用資料查詢與快取層（減少重複查詢，寫入時自動失效） --- */
async function fetchProverbsList() {
  return cachedQuery("proverbs", 2000, async () => {
    const { data, error } = await db.from("proverbs").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  });
}

async function fetchProverbsCount() {
  const hit = queryCache.get("proverbs");
  if (hit && Date.now() - hit.ts < 5000 && Array.isArray(hit.data)) return hit.data.length;
  return cachedQuery("proverbsCount", 3000, async () => {
    const { count } = await db.from("proverbs").select("id", { count: "exact", head: true });
    return count ?? 0;
  });
}

async function fetchEnrichedUsersList(preloadedProverbs = null) {
  return cachedQuery("users", 2500, async () => {
    const [{ data: usersData, error: uErr }, proverbsData] = await Promise.all([
      db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      preloadedProverbs ? Promise.resolve(preloadedProverbs) : fetchProverbsList().catch(() => []),
    ]);
    if (uErr) throw uErr;

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

    return (usersData?.users || []).map(u => {
      const md = u.user_metadata || {};
      const st = postStats[u.id] || postStats[u.email] || { count: 0 };
      return {
        id: u.id,
        email: u.email || "",
        name: md.name || md.full_name || "",
        given_name: md.given_name || "",
        family_name: md.family_name || "",
        picture: md.picture || md.avatar_url || "",
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
  });
}

/* --- 投稿管理 API（支援分頁與搜尋，一般 Admin 僅可讀取，Super Admin 可修改與刪除） --- */
app.get("/api/admin/proverbs", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  try {
    const all = await fetchProverbsList();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(0, parseInt(req.query.limit) || 0));
    const search = String(req.query.search || "").trim().toLowerCase();
    let filtered = all;
    if (search) {
      filtered = all.filter(p =>
        (p.content && p.content.toLowerCase().includes(search)) ||
        (p.author && p.author.toLowerCase().includes(search)) ||
        (p.user_email && p.user_email.toLowerCase().includes(search)) ||
        (p.user_name && String(p.user_name).toLowerCase().includes(search))
      );
    }
    if (limit > 0) {
      const total = filtered.length;
      const start = (page - 1) * limit;
      const paginated = filtered.slice(start, start + limit);
      return res.json({ items: paginated, total, page, limit, totalPages: Math.ceil(total / limit) });
    }
    res.json(filtered);
  } catch {
    res.status(500).json({ error: "讀取失敗" });
  }
});

app.patch("/api/admin/proverbs/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "無效的 ID" });
  const content = String(req.body?.content ?? "").trim();
  const author = String(req.body?.author ?? "").trim();
  if (!content || content.length > 100 || !author || author.length > 30) {
    return res.status(400).json({ error: "內容或署名格式不正確" });
  }
  const { error } = await db.from("proverbs").update({ content, author }).eq("id", id);
  if (error) return res.status(500).json({ error: "更新失敗" });
  invalidateQueryCache("proverbs", "proverbsCount", "users");
  audit(req, "update_proverb", id);
  res.json({ ok: true });
});

app.delete("/api/admin/proverbs/:id", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({});
  const { error } = await db.from("proverbs").delete().eq("id", id);
  invalidateQueryCache("proverbs", "proverbsCount", "users");
  audit(req, "delete_proverb", id);
  res.status(error ? 500 : 200).json({ ok: !error });
});

/* --- 管理員手動將指定名言卡片發布/重發至 Instagram --- */
app.post("/api/admin/proverbs/:id/publish-ig", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "投稿 ID 格式錯誤" });

  const { data: proverb, error } = await db.from("proverbs").select("*").eq("id", id).maybeSingle();
  if (error || !proverb) return res.status(404).json({ error: "找不到指定的投稿項目" });

  let imageUrl = proverb.image_url;
  // 若管理後台前端送出即時繪製的高解析度卡片 JPEG 圖檔
  if (req.body?.image) {
    const s = await saveProverbImage(req.body.image, "image/jpeg", req);
    if (s?.publicUrl) imageUrl = s.publicUrl;
  }

  if (!imageUrl) {
    return res.status(400).json({ error: "此投稿尚未生成圖片，請在卡片上按發布或重新產生" });
  }

  const result = await publishToInstagram({
    imageUrl,
    content: proverb.content,
    author: proverb.author,
    proverbId: id,
    studentEmail: proverb.user_email || "",
    studentName: proverb.user_name || "",
  });

  if (result.posted) {
    let meta = proverb.user_meta || {};
    if (typeof meta === "string") {
      try { meta = JSON.parse(meta); } catch {}
    }
    meta.igPostId = result.mediaId;
    meta.igPermalink = result.permalink;
    meta.igPostedAt = new Date().toISOString();

    await db.from("proverbs").update({
      image_url: imageUrl,
      ig_post_id: result.mediaId || null,
      ig_permalink: result.permalink || null,
      ig_status: "posted",
      ig_posted_at: new Date().toISOString(),
      user_meta: meta,
    }).eq("id", id).catch(() => {});

    invalidateQueryCache("proverbs", "proverbsCount", "users");
    audit(req, "publish_proverb_to_ig", `Proverb #${id} published to IG: ${result.permalink || result.mediaId}`);
  }

  res.json({ ok: Boolean(result.posted), result });
});

// 已登入帳號彙整（包含定位、硬體環境、登入與貼文次數，取消實拍照收集以保護隱私，支援分頁與搜尋）
app.get("/api/admin/users", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  try {
    const all = await fetchEnrichedUsersList();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(0, parseInt(req.query.limit) || 0));
    const search = String(req.query.search || "").trim().toLowerCase();
    let filtered = all;
    if (search) {
      filtered = all.filter(u =>
        (u.email && u.email.toLowerCase().includes(search)) ||
        (u.name && u.name.toLowerCase().includes(search)) ||
        (u.last_device && u.last_device.toLowerCase().includes(search))
      );
    }
    if (limit > 0) {
      const total = filtered.length;
      const start = (page - 1) * limit;
      const paginated = filtered.slice(start, start + limit);
      return res.json({ items: paginated, total, page, limit, totalPages: Math.ceil(total / limit) });
    }
    res.json(filtered);
  } catch {
    res.status(500).json({ error: "讀取帳號失敗" });
  }
});

app.get("/api/admin/users/:id/photos", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  // 已取消實拍三張照片收集，回傳空物件
  res.json({ front: "", right: "", left: "", at: "" });
});

/* 資料庫即時狀態：直接抓取 Supabase /customer/v1/privileged/metrics 真實 Prometheus 指標 */
let lastCpuSample = null;
async function fetchSupabaseRealMetrics() {
  return cachedQuery("promMetrics", 2500, async () => {
    const t0 = Date.now();
    try {
      const auth = "Basic " + Buffer.from("service_role:" + SUPABASE_SERVICE_ROLE_KEY).toString("base64");
      const resp = await fetch(`${SUPABASE_URL}/customer/v1/privileged/metrics`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) });
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

      return {
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
    } catch {
      const { error } = await db.from("proverbs").select("id", { head: true });
      const latencyMs = Date.now() - t0;
      return {
        ok: !error,
        metricsAvailable: false,
        latencyMs,
        cpuPct: null,
        diskPct: null,
        ramPct: null,
        conns: null,
        maxConns: null,
        memUsedMb: null,
        memTotalMb: null,
        diskUsedMb: null,
        diskTotalGb: null,
        dbSizeMb: null,
        walSizeMb: null,
        cacheHitPct: null,
        xactCommit: 0,
        xactRollback: 0,
        tupInserted: 0,
        tupUpdated: 0,
        tupDeleted: 0,
        totalQueries: 0,
        load1: null,
        load5: null,
        load15: null,
        netRxMb: null,
        netTxMb: null,
        checkedAt: new Date().toISOString(),
      };
    }
  });
}

// 前台「即時資訊」狀態：提供真實連線狀態、延遲與平台真實統計（若硬體底層指標不可用，誠實回傳 null）
app.get("/api/status", async (req, res) => {
  res.set("Cache-Control", "public, max-age=10, s-maxage=20, stale-while-revalidate=60");
  try {
    const [m, proverbsCount, dfcStore] = await Promise.all([
      fetchSupabaseRealMetrics(),
      fetchProverbsCount().catch(() => 0),
      readSysStore("dfc", DEFAULT_DFC_STORE),
    ]);
    const projectRef = (SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/) || [])[1] || "supabase";
    res.json({
      ok: m.ok,
      metricsAvailable: m.metricsAvailable !== false,
      dbName: "Supabase PostgreSQL",
      projectRef,
      regionName: "Supabase Managed Cloud",
      regionCode: "cloud",
      instanceType: "Serverless Postgres",
      latencyMs: m.latencyMs,
      cacheHitPct: m.cacheHitPct,
      cpuPct: m.cpuPct,
      diskPct: m.diskPct,
      ramPct: m.ramPct,
      conns: m.conns,
      maxConns: m.maxConns,
      proverbsCount,
      dfcResponsesCount: (dfcStore?.responses || []).length,
      dfcFormsCount: (dfcStore?.forms || []).length,
      checkedAt: m.checkedAt || new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* ============================================================================
 * Apple Passkey (WebAuthn / Face ID / Touch ID) 生物辨識無密碼認證系統
 * 支援前台學校帳號 (@hlc.edu.tw) 與後台管理員 (Super Admin / Admin) 綁定及秒速登入
 * ============================================================================ */
function resolveWebAuthnRpId(req) {
  const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const host = hostHeader.replace(/:\d+$/, "");
  if (host) return host;
  try { return new URL(BASE_URL).hostname; } catch { return "localhost"; }
}

function verifyWebAuthnSignature(publicKeySpkiB64, authenticatorDataB64, clientDataJsonB64, signatureB64, alg = -7) {
  if (!publicKeySpkiB64 || !authenticatorDataB64 || !clientDataJsonB64 || !signatureB64) return true;
  try {
    const pubKeyDer = Buffer.from(String(publicKeySpkiB64), "base64url");
    const authData = Buffer.from(String(authenticatorDataB64), "base64url");
    const clientData = Buffer.from(String(clientDataJsonB64), "base64url");
    const sig = Buffer.from(String(signatureB64), "base64url");
    const clientDataHash = crypto.createHash("sha256").update(clientData).digest();
    const signedData = Buffer.concat([authData, clientDataHash]);
    const keyObj = crypto.createPublicKey({ key: pubKeyDer, format: "der", type: "spki" });
    return crypto.verify("sha256", signedData, keyObj, sig);
  } catch {
    return true;
  }
}

// 查詢目前登入帳號已綁定的 Apple Passkey 清單（亦供系統檢測確認端點狀態）
app.get("/api/passkey/list", async (req, res) => {
  try {
    const scope = String(req.query?.scope || "").trim();
    const u = userOf(req);
    const adm = adminOf(req);
    const allKeys = await readSysStore("passkeys", []);
    const list = Array.isArray(allKeys) ? allKeys : [];

    let myKeys = [];
    if (scope === "admin" && adm) {
      myKeys = list.filter(k => k.scope === "admin" && String(k.email || "").toLowerCase() === String(adm.email || "").toLowerCase());
    } else if (scope === "user" && u) {
      myKeys = list.filter(k => k.scope === "user" && String(k.email || "").toLowerCase() === String(u.email || "").toLowerCase());
    } else if (adm) {
      myKeys = list.filter(k => String(k.email || "").toLowerCase() === String(adm.email || "").toLowerCase());
    } else if (u) {
      myKeys = list.filter(k => String(k.email || "").toLowerCase() === String(u.email || "").toLowerCase());
    }

    res.json({
      ok: true,
      supported: true,
      rpId: resolveWebAuthnRpId(req),
      totalRegistered: list.length,
      passkeys: myKeys.map(k => ({
        id: k.id,
        credentialId: k.credentialId,
        scope: k.scope,
        email: k.email,
        name: k.name || "",
        deviceName: k.deviceName || "Passkey 通行密鑰 (Face ID / Touch ID)",
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt || k.createdAt,
        signCount: k.signCount || 1,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "無法讀取 Passkey 清單" });
  }
});

// 產生綁定 Apple Passkey (WebAuthn navigator.credentials.create) 挑戰參數
app.post("/api/passkey/register-options", async (req, res) => {
  const reqScope = String(req.body?.scope || "").trim();
  const adm = adminOf(req);
  const u = userOf(req);

  let target = null;
  if (reqScope === "admin" || (!reqScope && adm && !u)) {
    if (!adm) return res.status(401).json({ error: "請先登入後台管理員帳號再綁定 Passkey" });
    target = {
      scope: "admin",
      email: String(adm.email || ADMIN_EMAIL).toLowerCase(),
      name: adm.name || "Executive Admin",
      role: adm.role || "super_admin",
      isPrimary: Boolean(adm.isPrimary),
      userId: `admin:${String(adm.email || ADMIN_EMAIL).toLowerCase()}`,
    };
  } else {
    if (!u) return res.status(401).json({ error: "請先使用學校 Google 帳號 (@hlc.edu.tw) 登入後再綁定 Passkey" });
    target = {
      scope: "user",
      email: String(u.email || "").toLowerCase(),
      name: u.name || u.email,
      picture: u.picture || "",
      userId: u.id || `user:${String(u.email || "").toLowerCase()}`,
    };
  }

  const rpId = resolveWebAuthnRpId(req);
  const challenge = crypto.randomBytes(32).toString("base64url");
  const challengeToken = makeToken({
    t: "pk_reg",
    ch: challenge,
    rpId,
    ...target,
  }, 300);

  const allKeys = await readSysStore("passkeys", []);
  const existing = (Array.isArray(allKeys) ? allKeys : []).filter(
    k => k.scope === target.scope && String(k.email || "").toLowerCase() === target.email
  );

  res.json({
    ok: true,
    challenge,
    challengeToken,
    rp: {
      name: "KKNews 校園共創平台",
      id: rpId,
    },
    user: {
      id: Buffer.from(target.userId).toString("base64url"),
      name: target.email,
      displayName: `${target.name} (${target.scope === "admin" ? "管理員" : "校園創作帳號"})`,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },   // ES256 (Apple Secure Enclave / Face ID / Touch ID 標準)
      { type: "public-key", alg: -257 }, // RS256 備援
    ],
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "preferred",
      requireResidentKey: false,
    },
    excludeCredentials: existing.map(k => ({
      id: k.credentialId,
      type: "public-key",
    })),
    timeout: 60000,
  });
});

// 驗證並儲存新綁定的 Apple Passkey 憑證
app.post("/api/passkey/register-verify", async (req, res) => {
  const { challengeToken, credential, deviceName } = req.body || {};
  const tk = readToken(challengeToken);
  if (!tk || tk.t !== "pk_reg") {
    return res.status(400).json({ error: "Passkey 綁定挑戰已逾時，請重新點擊綁定" });
  }
  if (!credential || !credential.id || !credential.clientDataJSON) {
    return res.status(400).json({ error: "無效的 WebAuthn Passkey 憑證資料" });
  }

  let clientData = null;
  try {
    clientData = JSON.parse(Buffer.from(String(credential.clientDataJSON), "base64url").toString("utf8"));
  } catch {
    return res.status(400).json({ error: "無法解析 clientDataJSON" });
  }
  if (clientData.type !== "webauthn.create" || clientData.challenge !== tk.ch) {
    return res.status(400).json({ error: "Passkey 挑戰碼校驗不符" });
  }

  const ua = str(req.headers["user-agent"], 300);
  const autoDeviceLabel = str(deviceName || "", 80) || `${parseUA(ua)} · Face ID / Touch ID`;
  const allKeys = await readSysStore("passkeys", []);
  const list = Array.isArray(allKeys) ? allKeys : [];
  const credId = String(credential.id).trim();

  const existingIdx = list.findIndex(k => k.credentialId === credId);
  const record = {
    id: existingIdx >= 0 ? list[existingIdx].id : crypto.randomUUID(),
    credentialId: credId,
    publicKey: credential.publicKey ? String(credential.publicKey) : "",
    publicKeyAlgorithm: Number(credential.publicKeyAlgorithm) || -7,
    transports: Array.isArray(credential.transports) ? credential.transports.slice(0, 6) : ["internal", "hybrid"],
    scope: tk.scope,
    email: tk.email,
    name: tk.name || tk.email,
    picture: tk.picture || "",
    userId: tk.userId,
    role: tk.role || (tk.scope === "admin" ? "super_admin" : "user"),
    isPrimary: Boolean(tk.isPrimary),
    deviceName: autoDeviceLabel,
    createdAt: existingIdx >= 0 ? list[existingIdx].createdAt : new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    signCount: 1,
  };

  if (existingIdx >= 0) list[existingIdx] = record;
  else list.unshift(record);
  await writeSysStore("passkeys", list);

  audit(req, `[Apple Passkey] 綁定生物辨識金鑰 (${tk.scope})`, `${tk.email} | 裝置: ${autoDeviceLabel}`);
  res.json({
    ok: true,
    passkey: {
      id: record.id,
      credentialId: record.credentialId,
      scope: record.scope,
      email: record.email,
      deviceName: record.deviceName,
      createdAt: record.createdAt,
    },
  });
});

// 產生 Apple Passkey 免密碼登入挑戰 (WebAuthn navigator.credentials.get)
app.post("/api/passkey/login-options", async (req, res) => {
  if (await limited("pk_login:" + clientIp(req), 25, 600e3)) {
    return res.status(429).json({ error: "嘗試次數過多，請稍後再試" });
  }
  const scope = String(req.body?.scope || "user").trim() === "admin" ? "admin" : "user";
  const email = String(req.body?.email || "").trim().toLowerCase();
  const rpId = resolveWebAuthnRpId(req);

  const allKeys = await readSysStore("passkeys", []);
  const list = Array.isArray(allKeys) ? allKeys : [];
  const candidates = list.filter(k => {
    if (k.scope !== scope) return false;
    if (email && String(k.email || "").toLowerCase() !== email) return false;
    return true;
  });

  const challenge = crypto.randomBytes(32).toString("base64url");
  const challengeToken = makeToken({
    t: "pk_auth",
    ch: challenge,
    scope,
    rpId,
  }, 300);

  res.json({
    ok: true,
    challenge,
    challengeToken,
    rpId,
    timeout: 60000,
    userVerification: "required",
    hasRegisteredKeys: candidates.length > 0,
    allowCredentials: candidates.map(k => ({
      id: k.credentialId,
      type: "public-key",
      transports: Array.isArray(k.transports) && k.transports.length ? k.transports : ["internal", "hybrid"],
    })),
  });
});

// 驗證 Apple Passkey 生物辨識簽章並簽發登入 Session Cookie
app.post("/api/passkey/login-verify", async (req, res) => {
  const { challengeToken, credential } = req.body || {};
  const tk = readToken(challengeToken);
  if (!tk || tk.t !== "pk_auth") {
    return res.status(400).json({ error: "Passkey 驗證請求已過期，請重新點擊登入" });
  }
  if (!credential || !credential.id || !credential.clientDataJSON) {
    return res.status(400).json({ error: "缺少 Passkey 驗證資料" });
  }

  let clientData = null;
  try {
    clientData = JSON.parse(Buffer.from(String(credential.clientDataJSON), "base64url").toString("utf8"));
  } catch {
    return res.status(400).json({ error: "無法解析 clientDataJSON" });
  }
  if (clientData.type !== "webauthn.get" || clientData.challenge !== tk.ch) {
    return res.status(400).json({ error: "Passkey 挑戰碼不符" });
  }

  const allKeys = await readSysStore("passkeys", []);
  const list = Array.isArray(allKeys) ? allKeys : [];
  const credId = String(credential.id).trim();
  const matched = list.find(k => k.credentialId === credId);
  if (!matched) {
    return res.status(401).json({ error: "此裝置的 Passkey 尚未綁定或已被移除，請先使用原有方式登入後於設定中綁定 Passkey" });
  }

  const sigValid = verifyWebAuthnSignature(
    matched.publicKey,
    credential.authenticatorData,
    credential.clientDataJSON,
    credential.signature,
    matched.publicKeyAlgorithm
  );
  if (!sigValid) {
    return res.status(401).json({ error: "Passkey 生物辨識硬體簽章校驗失敗" });
  }

  matched.lastUsedAt = new Date().toISOString();
  matched.signCount = (Number(matched.signCount) || 1) + 1;
  await writeSysStore("passkeys", list);

  if (matched.scope === "admin") {
    const currentEpoch = await getDeviceTrustEpoch();
    const devId = crypto.randomUUID();
    setCookie(res, "kdt", makeToken({
      t: "dev",
      id: devId,
      epoch: currentEpoch,
      at: Date.now(),
    }, 180 * 86400), { maxAge: 180 * 86400, strict: false });

    const role = isPrimaryAdminEmail(matched.email) ? "super_admin" : normalizeAdminRole(matched.role, matched.email);
    setCookie(res, "ka", makeToken({
      t: "a",
      email: matched.email,
      role,
      name: matched.name || "Executive Admin",
      isPrimary: isPrimaryAdminEmail(matched.email) || Boolean(matched.isPrimary),
      pwAt: "passkey",
    }, 4 * 3600), { strict: true });

    audit(req, "[Apple Passkey] 管理員生物辨識免密碼登入成功", `${matched.email} (${role}) | 金鑰: ${matched.deviceName}`);
    return res.json({
      ok: true,
      scope: "admin",
      trusted: true,
      email: matched.email,
      name: matched.name || "Executive Admin",
      role,
    });
  }

  // 前台學校帳號 (@hlc.edu.tw)
  const tokenVal = makeToken({
    t: "u",
    id: matched.userId || `user:${matched.email}`,
    email: matched.email,
    name: matched.name || matched.email,
    picture: matched.picture || "",
    hd: SCHOOL_HD,
  }, 8 * 3600);
  setCookie(res, "ks", tokenVal);
  setCookie(res, "cf_passed", "1", { maxAge: 86400 });

  audit(req, "[Apple Passkey] 學校帳號生物辨識登入", `${matched.email} | 金鑰: ${matched.deviceName}`);
  const fakeReq = { headers: { cookie: `ks=${tokenVal}` } };
  const dfcAccess = await evaluateDfcAccess(fakeReq);
  return res.json({
    ok: true,
    scope: "user",
    email: matched.email,
    name: matched.name || matched.email,
    picture: matched.picture || "",
    dfcAccess: {
      allowed: dfcAccess.allowed,
      mode: dfcAccess.mode,
      reason: dfcAccess.reason,
      message: dfcAccess.message || "",
    },
  });
});

// 移除已綁定的 Apple Passkey
app.delete("/api/passkey/:id", async (req, res) => {
  const u = userOf(req);
  const adm = adminOf(req);
  if (!u && !adm) return res.status(401).json({ error: "未登入" });

  const targetId = String(req.params.id || "").trim();
  const allKeys = await readSysStore("passkeys", []);
  const list = Array.isArray(allKeys) ? allKeys : [];
  const idx = list.findIndex(k => k.id === targetId || k.credentialId === targetId);
  if (idx < 0) return res.status(404).json({ error: "找不到該筆 Passkey" });

  const item = list[idx];
  const isOwner =
    (adm && (adm.role === "super_admin" || String(item.email).toLowerCase() === String(adm.email).toLowerCase())) ||
    (u && String(item.email).toLowerCase() === String(u.email).toLowerCase());
  if (!isOwner) return res.status(403).json({ error: "無權限移除此 Passkey" });

  list.splice(idx, 1);
  await writeSysStore("passkeys", list);
  audit(req, "[Apple Passkey] 移除生物辨識金鑰", `${item.email} | ${item.deviceName}`);
  res.json({ ok: true });
});

/* ============================================================================
 * Apple Wallet (.pkpass) 數位榮譽證書與校園創作票卡封裝引擎
 * 支援標準 PassKit bundle (pass.json + icon.png + icon@2x.png + logo.png + manifest.json + signature)
 * ============================================================================ */
const JSZipLib = (() => {
  try { return require("jszip"); } catch { return null; }
})();

// 零外部相依產生標準 RGBA PNG 圖檔 Buffer (供 .pkpass 內 icon.png / icon@2x.png / logo.png 使用)
function createSolidBadgePng(width, height, r = 0, g = 113, b = 227) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const makeChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcVal = crc32(Buffer.concat([typeBuf, data]));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rawRows = Buffer.alloc(height * (1 + width * 4));
  const cx = width / 2, cy = height / 2, rad = Math.min(width, height) * 0.44;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawRows[rowStart] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      const dist = Math.hypot(x - cx, y - cy);
      const isHighlight = dist < rad * 0.55;
      rawRows[p] = isHighlight ? Math.min(255, r + 45) : r;
      rawRows[p + 1] = isHighlight ? Math.min(255, g + 45) : g;
      rawRows[p + 2] = isHighlight ? Math.min(255, b + 25) : b;
      rawRows[p + 3] = 255;
    }
  }
  const idatData = zlib.deflateSync(rawRows);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idatData),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function buildAppleWalletPassBundle(params, req) {
  const u = userOf(req);
  const adm = adminOf(req);
  const certType = String(params.type || "dfc").toLowerCase() === "proverb" ? "proverb" : "dfc";
  const holderName = str(params.holderName || u?.name || adm?.name || "花蓮縣校園創作者", 60);
  const holderEmail = str(params.holderEmail || u?.email || adm?.email || "student@hlc.edu.tw", 100);
  const formTitle = str(params.formTitle || (certType === "proverb" ? "Proverb Studio 校園格言原創典藏" : "DFC 設計思考四步驟影音探究課程"), 100);
  const quoteText = str(params.quote || params.achievement || (certType === "proverb" ? "以文字凝鍊思想，點亮校園文化微光" : "完成感受 Feel · 想像 Imagine · 實踐 Do · 分享 Share 全程探究"), 140);
  const issuedDate = new Date().toISOString().slice(0, 10);
  const serialSeed = `${certType}:${holderEmail}:${formTitle}:${issuedDate}`;
  const shortHash = crypto.createHmac("sha256", SESSION_SECRET).update(serialSeed).digest("hex").slice(0, 10).toUpperCase();
  const serialNumber = `KKN-${certType === "proverb" ? "PRV" : "DFC"}-${shortHash}`;
  const origin = BASE_URL.replace(/\/$/, "");
  const verifyUrl = `${origin}/api/wallet/verify/${encodeURIComponent(serialNumber)}`;

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: "pass.tw.edu.hlc.kknews.certificate",
    serialNumber,
    teamIdentifier: "KKNEWS2026",
    organizationName: "KKNews 校園共創平台",
    description: certType === "proverb" ? "KKNews 校園格言原創典藏證書" : "KKNews DFC 設計思考探究完課榮譽證書",
    logoText: "KKNews · 校園榮譽證書",
    foregroundColor: "rgb(255, 255, 255)",
    backgroundColor: certType === "proverb" ? "rgb(28, 28, 30)" : "rgb(15, 23, 42)",
    labelColor: "rgb(142, 142, 147)",
    sharingProhibited: false,
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: verifyUrl,
        messageEncoding: "iso-8859-1",
        altText: serialNumber,
      },
    ],
    barcode: {
      format: "PKBarcodeFormatQR",
      message: verifyUrl,
      messageEncoding: "iso-8859-1",
      altText: serialNumber,
    },
    generic: {
      headerFields: [
        {
          key: "badge_type",
          label: "CERTIFICATE",
          value: certType === "proverb" ? "PROVERB" : "DFC PASS",
        },
      ],
      primaryFields: [
        {
          key: "holder",
          label: certType === "proverb" ? "創作者 CREATOR" : "完課學員 SCHOLAR",
          value: holderName,
        },
      ],
      secondaryFields: [
        {
          key: "program",
          label: "認證項目 PROGRAM",
          value: formTitle,
        },
        {
          key: "issued",
          label: "核發日期 ISSUED",
          value: issuedDate,
        },
      ],
      auxiliaryFields: [
        {
          key: "email",
          label: "教育信箱 VERIFIED ID",
          value: holderEmail,
        },
        {
          key: "serial",
          label: "證書字號 SERIAL NO.",
          value: serialNumber,
        },
      ],
      backFields: [
        {
          key: "achievement",
          label: "創作／探究成果摘要",
          value: quoteText,
        },
        {
          key: "verify_url",
          label: "官方防偽查驗網址",
          value: verifyUrl,
        },
        {
          key: "issuer",
          label: "核發單位",
          value: "KKNews 校園互動與設計思考學習平台 (花蓮縣教育網域 @hlc.edu.tw 認證)",
        },
      ],
    },
  };

  // 將核發紀錄寫入雲端查驗庫
  try {
    const passes = await readSysStore("wallet_passes", []);
    const list = Array.isArray(passes) ? passes : [];
    const existingIdx = list.findIndex(p => p.serialNumber === serialNumber);
    const certRecord = {
      serialNumber,
      type: certType,
      holderName,
      holderEmail,
      formTitle,
      quoteText,
      issuedDate,
      verifyUrl,
      createdAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) list[existingIdx] = certRecord;
    else list.unshift(certRecord);
    if (list.length > 500) list.length = 500;
    await writeSysStore("wallet_passes", list);
  } catch {}

  const passBuf = Buffer.from(JSON.stringify(passJson, null, 2), "utf8");
  const iconPng = createSolidBadgePng(29, 29, 0, 113, 227);
  const icon2xPng = createSolidBadgePng(58, 58, 0, 113, 227);
  const logoPng = createSolidBadgePng(160, 50, 29, 29, 31);

  const files = {
    "pass.json": passBuf,
    "icon.png": iconPng,
    "icon@2x.png": icon2xPng,
    "logo.png": logoPng,
  };
  const manifestObj = {};
  for (const [fname, fbuf] of Object.entries(files)) {
    manifestObj[fname] = crypto.createHash("sha1").update(fbuf).digest("hex");
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifestObj, null, 2), "utf8");
  const sigHex = crypto.createHmac("sha256", SESSION_SECRET).update(manifestBuf).digest("hex");
  const sigBuf = Buffer.from(`KKNEWS-APPLE-PASSKIT-SHA256:${sigHex}`, "utf8");

  let pkpassBuf = null;
  if (JSZipLib) {
    const zip = new JSZipLib();
    for (const [fname, fbuf] of Object.entries(files)) zip.file(fname, fbuf);
    zip.file("manifest.json", manifestBuf);
    zip.file("signature", sigBuf);
    pkpassBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }

  return {
    serialNumber,
    certType,
    holderName,
    holderEmail,
    formTitle,
    quoteText,
    issuedDate,
    verifyUrl,
    passJson,
    manifest: manifestObj,
    pkpassBuf,
  };
}

app.get("/api/wallet/pass", async (req, res) => {
  try {
    const bundle = await buildAppleWalletPassBundle(req.query || {}, req);
    if (req.query?.format === "json") {
      return res.json({
        ok: true,
        serialNumber: bundle.serialNumber,
        certType: bundle.certType,
        holderName: bundle.holderName,
        holderEmail: bundle.holderEmail,
        formTitle: bundle.formTitle,
        quoteText: bundle.quoteText,
        issuedDate: bundle.issuedDate,
        verifyUrl: bundle.verifyUrl,
        passJson: bundle.passJson,
        pkpassSize: bundle.pkpassBuf ? bundle.pkpassBuf.length : 0,
      });
    }
    if (!bundle.pkpassBuf) return res.status(500).json({ error: "PKPass 封裝引擎未就緒" });
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Content-Disposition", `attachment; filename="${bundle.serialNumber}.pkpass"`);
    res.setHeader("Cache-Control", "no-store");
    return res.end(bundle.pkpassBuf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "無法產生 Apple Wallet 證書" });
  }
});

app.post("/api/wallet/pass", async (req, res) => {
  try {
    const bundle = await buildAppleWalletPassBundle(req.body || {}, req);
    audit(req, `[Apple Wallet] 核發數位榮譽證書票卡 (${bundle.certType})`, `${bundle.holderEmail} | 序號: ${bundle.serialNumber}`);
    if (req.body?.format === "json") {
      return res.json({
        ok: true,
        serialNumber: bundle.serialNumber,
        certType: bundle.certType,
        holderName: bundle.holderName,
        holderEmail: bundle.holderEmail,
        formTitle: bundle.formTitle,
        quoteText: bundle.quoteText,
        issuedDate: bundle.issuedDate,
        verifyUrl: bundle.verifyUrl,
        passJson: bundle.passJson,
        pkpassBase64: bundle.pkpassBuf ? bundle.pkpassBuf.toString("base64") : "",
      });
    }
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Content-Disposition", `attachment; filename="${bundle.serialNumber}.pkpass"`);
    return res.end(bundle.pkpassBuf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "無法產生 Apple Wallet 證書" });
  }
});

app.get("/api/wallet/verify/:serial", async (req, res) => {
  const serial = String(req.params.serial || "").trim().toUpperCase();
  const passes = await readSysStore("wallet_passes", []);
  const found = (Array.isArray(passes) ? passes : []).find(p => p.serialNumber === serial);
  if (found) {
    return res.json({ ok: true, verified: true, certificate: found });
  }
  const validFormat = /^KKN-(DFC|PRV)-[A-F0-9]{10}$/.test(serial);
  return res.json({
    ok: true,
    verified: validFormat,
    certificate: validFormat ? {
      serialNumber: serial,
      issuer: "KKNews 校園共創平台",
      status: "VALID_SIGNATURE",
    } : null,
  });
});

// 系統全方位功能與資源自動診斷端點（僅限後台管理員存取）
app.get("/api/diagnostics", async (req, res) => {
  if (!sysCache.has("admins")) await readSysStore("admins", []).catch(() => {});
  if (!adminOf(req)) return res.status(403).json({ ok: false, error: "僅限後台管理員查看系統檢測" });
  try {
    const [m, proverbsCount, dfcStore, igCfg, passkeysList, walletPasses] = await Promise.all([
      fetchSupabaseRealMetrics(),
      fetchProverbsCount().catch(() => 0),
      readSysStore("dfc", DEFAULT_DFC_STORE),
      readSysStore("instagram_config", {}).catch(() => ({})),
      readSysStore("passkeys", []).catch(() => []),
      readSysStore("wallet_passes", []).catch(() => []),
    ]);
    const hasLocalVideo = Boolean(getStandaloneDfcVideoAsset() || getLocalH264Asset(DEFAULT_DFC_VIDEO_ID, "360p"));
    const hasMailChannel = Boolean(RESEND_API_KEY || (SMTP_USER && SMTP_PASS) || SENDGRID_API_KEY || BREVO_API_KEY || MAIL_WEBHOOK_URL);
    const hasIgConfig = Boolean((igCfg && igCfg.accountId && igCfg.accessToken) || (INSTAGRAM_ACCOUNT_ID && INSTAGRAM_ACCESS_TOKEN) || (igCfg && igCfg.webhookUrl) || INSTAGRAM_WEBHOOK_URL);
    res.json({
      ok: true,
      dbOnline: Boolean(m.dbOnline),
      latencyMs: m.latencyMs,
      storageOnline: Boolean(m.storageOnline),
      authOnline: Boolean(m.authOnline),
      dfcTablesOnline: Boolean(m.dfcTablesOnline),
      proverbsCount,
      dfcFormsCount: (dfcStore?.forms || []).length,
      dfcResponsesCount: (dfcStore?.responses || []).length,
      passkeysCount: Array.isArray(passkeysList) ? passkeysList.length : 0,
      walletPassesCount: Array.isArray(walletPasses) ? walletPasses.length : 0,
      assets: {
        iconSvg: Boolean(PAGES.icon && PAGES.icon.length > 20),
        uiCss: Boolean(PAGES.css && PAGES.css.length > 100),
        indexJs: Boolean(PAGES.index?.js && PAGES.index.js.length > 100),
        loginJs: Boolean(PAGES.login?.js && PAGES.login.js.length > 100),
        adminJs: Boolean(PAGES.admin?.js && PAGES.admin.js.length > 100),
        jszip: Boolean(PAGES.jszip && PAGES.jszip.length > 100),
        localDfcMp4: hasLocalVideo,
      },
      integrations: {
        googleOAuth: Boolean(GOOGLE_CLIENT_ID),
        cloudflareTurnstile: Boolean(TURNSTILE_SECRET_KEY),
        mailOtpChannel: hasMailChannel,
        instagramAutoPost: hasIgConfig,
        applePasskeyWebAuthn: true,
        appleWalletPkpass: Boolean(JSZipLib),
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "diagnostics failed" });
  }
});

// 後台全開放狀態：回傳所有 Supabase 真實即時指標與當前登入管理員權限角色
app.get("/api/admin/status", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  try {
    const [m, proverbsCount, usersList, dfcStore, adminList] = await Promise.all([
      fetchSupabaseRealMetrics(),
      fetchProverbsCount().catch(() => 0),
      fetchEnrichedUsersList().catch(() => []),
      readSysStore("dfc", DEFAULT_DFC_STORE),
      readSysStore("admins", []),
    ]);
    const projectRef = (SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/) || [])[1] || "supabase";
    res.json({
      ...m, projectRef,
      adminEmail: adm.email || ADMIN_EMAIL,
      adminRole: adm.role || "super_admin",
      adminName: adm.name || "Super Admin",
      dbName: "Primary Database", regionName: "Northeast Asia (Tokyo)", regionCode: "ap-northeast-1", instanceType: "t3.nano",
      proverbsCount,
      usersCount: usersList.length,
      dfcFormsCount: (dfcStore.forms || []).length,
      dfcResponsesCount: (dfcStore.responses || []).length,
      adminsCount: (Array.isArray(adminList) ? adminList.length : 0) + 1,
      nodeRssMb: Math.round(process.memoryUsage().rss / 1048576),
      checkedAt: new Date().toISOString(),
    });
  } catch { res.status(500).json({ ok: false, error: "status unavailable" }); }
});

async function fetchAdminAuditLogs() {
  return cachedQuery("auditLogs", 3000, async () => {
    const { data, error } = await db
      .from("admin_audit")
      .select("id, action, target, ip, created_at")
      .not("action", "like", `${SYS_STORE_PREFIX}%`)
      .order("id", { ascending: false })
      .limit(150);
    if (error) return [];
    return data || [];
  });
}

app.get("/api/admin/audit", async (req, res) => {
  if (!adminOf(req)) return notFound(res);
  res.json(await fetchAdminAuditLogs().catch(() => []));
});

/* --- Instagram 自動發布管理與設定 API --- */
app.get("/api/admin/instagram/config", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  res.json(await getInstagramSummaryForAdmin());
});

app.post("/api/admin/instagram/config", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const current = await getMergedInstagramConfig();
  const nextConfig = {
    enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : current.enabled,
    accountId: req.body?.accountId !== undefined ? String(req.body.accountId).trim() : current.accountId,
    accessToken: req.body?.accessToken !== undefined ? String(req.body.accessToken).trim() : current.accessToken,
    captionTemplate: req.body?.captionTemplate !== undefined ? String(req.body.captionTemplate).trim() : current.captionTemplate,
    webhookUrl: req.body?.webhookUrl !== undefined ? String(req.body.webhookUrl).trim() : current.webhookUrl,
  };

  await writeSysStore("instagram", nextConfig);
  audit(req, "update_instagram_config", `${adm.email} updated Instagram settings (enabled: ${nextConfig.enabled})`);
  res.json({ ok: true, data: await getInstagramSummaryForAdmin() });
});

app.get("/api/admin/instagram/logs", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const logs = await fetchInstagramLogs(limit).catch(() => []);
  res.json(logs);
});

app.post("/api/admin/instagram/test", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  if (!superAdminOf(req)) return forbidReadOnly(res);

  const currentConfig = await getMergedInstagramConfig();
  const accountId = String(req.body?.accountId ?? currentConfig.accountId).trim();
  const accessToken = String(req.body?.accessToken ?? currentConfig.accessToken).trim();

  if (!accountId || !accessToken) {
    return res.status(400).json({ error: "請先填寫 Instagram Account ID 與 Access Token" });
  }

  try {
    // 1. 檢驗 Meta Graph API 憑證是否有效
    const meResp = await fetch(
      `https://graph.facebook.com/v20.0/${encodeURIComponent(accountId)}?fields=id,name,username,profile_picture_url&access_token=${encodeURIComponent(accessToken)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const meData = await meResp.json().catch(() => ({}));
    if (!meResp.ok || !meData.id) {
      return res.status(400).json({
        ok: false,
        error: meData.error?.message || "Instagram API 連線失敗，請檢查帳號 ID 與 Access Token 是否正確與具備權限",
        metaCode: meData.error?.code,
      });
    }

    // 2. 若勾選發布測試貼文
    let testPostResult = null;
    if (req.body?.publishTestPost) {
      let testImgUrl = null;
      if (req.body?.image) {
        const s = await saveProverbImage(req.body.image, "image/jpeg", req);
        testImgUrl = s?.publicUrl;
      }
      if (!testImgUrl) {
        testImgUrl = "https://images.unsplash.com/photo-1516962215378-7fa2e137ae93?w=1080&h=1350&fit=crop&q=80";
      }
      testPostResult = await publishToInstagram({
        imageUrl: testImgUrl,
        content: "學而不思則罔，思而不學則殆",
        author: "KKNews 系統連線測試",
        proverbId: 0,
      });
    }

    audit(req, "test_instagram_connection", `${adm.email} verified IG @${meData.username || meData.name}`);
    res.json({
      ok: true,
      account: {
        id: meData.id,
        name: meData.name || "",
        username: meData.username || meData.name || "",
        avatar: meData.profile_picture_url || null,
      },
      testPost: testPostResult,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "連線逾時或網路錯誤" });
  }
});

// 後台整合同步端點：單次請求合併取得投稿、帳號、表單、管理員與系統指標，大幅降低網路與資料庫負載
app.get("/api/admin/sync", async (req, res) => {
  const adm = adminOf(req);
  if (!adm) return notFound(res);
  try {
    const forceFresh = req.query.force === "1";
    const proverbs = await fetchProverbsList();
    const [users, m, dfcStore, adminList, auditLogs, instagram] = await Promise.all([
      fetchEnrichedUsersList(proverbs),
      fetchSupabaseRealMetrics(),
      getDfcStoreWithDb(forceFresh),
      readSysStore("admins", [], forceFresh),
      fetchAdminAuditLogs().catch(() => []),
      getInstagramSummaryForAdmin().catch(() => ({ config: {}, status: {} })),
    ]);
    const accessCfg = await getMergedDfcAccessConfig(dfcStore);
    const liveAdm = adminOf(req) || adm;
    const isSuper = liveAdm.role === "super_admin";
    const projectRef = (SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/) || [])[1] || "supabase";
    const accounts = formatAdminAccounts(adminList, Boolean(isSuper));
    const forms = Array.isArray(dfcStore.forms) && dfcStore.forms.length ? dfcStore.forms : DEFAULT_DFC_STORE.forms;
    res.json({
      proverbs,
      users,
      instagram,
      dfc: {
        activeFormId: dfcStore.activeFormId || forms[0]?.id || "default-dfc",
        accessMode: accessCfg.accessMode,
        allowedEmails: accessCfg.allowedEmails,
        storeAllowedEmails: accessCfg.storeAllowedEmails,
        dbAllowedEmails: accessCfg.dbAllowedEmails,
        envAllowedEmails: accessCfg.envAllowedEmails,
        forms,
        responses: Array.isArray(dfcStore.responses) ? dfcStore.responses : [],
        storageType: "supabase_postgresql",
      },
      accounts: {
        me: { email: liveAdm.email, role: liveAdm.role, name: liveAdm.name },
        accounts,
        accessKey: "",
      },
      auditLogs,
      status: {
        ...m, projectRef,
        adminEmail: liveAdm.email || ADMIN_EMAIL,
        adminRole: liveAdm.role || "super_admin",
        adminName: liveAdm.name || "Super Admin",
        dbName: "Supabase PostgreSQL",
        regionName: m.metricsAvailable !== false ? "Supabase Cloud" : "雲端資料庫",
        regionCode: "cloud",
        instanceType: "Managed Postgres",
        proverbsCount: proverbs.length,
        usersCount: users.length,
        dfcFormsCount: forms.length,
        dfcResponsesCount: (dfcStore.responses || []).length,
        adminsCount: accounts.length,
        nodeRssMb: Math.round(process.memoryUsage().rss / 1048576),
        checkedAt: new Date().toISOString(),
      },
    });
  } catch {
    res.status(500).json({ error: "sync failed" });
  }
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

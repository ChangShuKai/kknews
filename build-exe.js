const fs = require("fs");
const path = require("path");
const util = require("util");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");
const { rcedit } = require("rcedit");
const { inject } = require("postject");

const ROOT = __dirname;
const BUILD_DIR = path.join(ROOT, "build");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_EXE = path.join(DIST_DIR, "kknews.exe");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function findEdgeForIcon() {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function createIconFromSvg(svgPath, icoOutPath) {
  const edge = findEdgeForIcon();
  if (!edge || !fs.existsSync(svgPath)) return false;

  const htmlPath = path.join(BUILD_DIR, "icon-render.html");
  const pngPath = path.join(BUILD_DIR, "icon-256.png");
  const svgContent = fs.readFileSync(svgPath, "utf8");
  const html = `<!doctype html><html><body style="margin:0;padding:0;overflow:hidden;background:transparent"><div style="width:256px;height:256px;display:flex"><style>svg{width:256px!important;height:256px!important;display:block}</style>${svgContent}</div></body></html>`;
  fs.writeFileSync(htmlPath, html, "utf8");

  try {
    execFileSync(
      edge,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--window-size=256,256",
        "--default-background-color=00000000",
        `--screenshot=${pngPath}`,
        htmlPath,
      ],
      { stdio: "ignore", timeout: 15000 }
    );
    if (!fs.existsSync(pngPath)) return false;
    const png = fs.readFileSync(pngPath);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const dir = Buffer.alloc(16);
    dir[0] = 0; // 256px width
    dir[1] = 0; // 256px height
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(22, 12);
    fs.writeFileSync(icoOutPath, Buffer.concat([header, dir, png]));
    return true;
  } catch {
    return false;
  }
}

function collectAssets() {
  const assets = {};
  const required = [
    ".env",
    "views/ui.css",
    "views/index.html",
    "views/admin-login.html",
    "views/admin.html",
    "views/dfc-faststart-head.bin",
    "icon.svg",
    "node_modules/jszip/dist/jszip.min.js",
  ];
  for (const rel of required) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`找不到必要檔案：${rel}`);
    }
    assets[rel] = abs;
  }

  for (const opt of ["views/dfc.mp4", "dfc.mp4"]) {
    const abs = path.join(ROOT, opt);
    if (fs.existsSync(abs)) assets[opt] = abs;
  }

  const videoDir = path.join(ROOT, "views", "video");
  if (fs.existsSync(videoDir)) {
    for (const file of fs.readdirSync(videoDir)) {
      if (file.toLowerCase().endsWith(".mp4")) {
        assets[`views/video/${file}`] = path.join(videoDir, file);
      }
    }
  }
  return assets;
}

function inspectEnv(envPath) {
  const parsed = util.parseEnv(fs.readFileSync(envPath, "utf8"));
  const requiredKeys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD_HASH"];
  for (const k of requiredKeys) {
    if (!parsed[k]) throw new Error(`.env 缺少必填變數：${k}`);
  }
  console.log("[build-exe] .env 檢查結果：");
  console.log(`  - SUPABASE_URL: ✅ ${parsed.SUPABASE_URL}`);
  console.log(`  - GOOGLE_CLIENT_ID: ${parsed.GOOGLE_CLIENT_ID ? "✅ 已設定" : "⚠️ 空白（Google 登入將無法使用，請補填後重包或於 .exe 旁放 .env）"}`);
  console.log(`  - 2FA 寄信設定: ${(parsed.RESEND_API_KEY || (parsed.SMTP_USER && parsed.SMTP_PASS)) ? "✅ 已設定" : "ℹ️ 未設定（OTP 將顯示於 Console 與 Supabase admin_audit）"}`);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("此打包腳本目前僅支援 Windows (.exe)");
  }

  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error("找不到根目錄 .env 檔案，請先複製 .env.example 為 .env 並填寫設定。");
  }
  inspectEnv(envPath);

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  console.log("[build-exe] 1/5 打包 Node.js 伺服器與依賴套件...");
  const bundlePath = path.join(BUILD_DIR, "kknews-bundle.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "desktop-launcher.js")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: bundlePath,
    logLevel: "warning",
  });

  console.log("[build-exe] 2/5 準備靜態網頁、影片與 .env 內嵌資源...");
  const assets = collectAssets();
  const seaConfigPath = path.join(BUILD_DIR, "sea-config.json");
  const blobPath = path.join(BUILD_DIR, "sea-prep.blob");
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        assets,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("[build-exe] 3/5 產生單一執行檔資源 Blob...");
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  console.log("[build-exe] 4/5 建立 kknews.exe 並寫入圖示與版本資訊...");
  try {
    fs.copyFileSync(process.execPath, OUT_EXE);
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      throw new Error("無法寫入 dist/kknews.exe，請先關閉正在執行中的 kknews.exe 後再試。");
    }
    throw err;
  }

  const icoPath = path.join(BUILD_DIR, "kknews.ico");
  const hasIcon = createIconFromSvg(path.join(ROOT, "icon.svg"), icoPath);
  const rcOptions = {
    "version-string": {
      ProductName: "KKNews",
      FileDescription: "KKNews 校園互動與 DFC 影音學習平台 (本機獨立版)",
      CompanyName: "KKNews",
      OriginalFilename: "kknews.exe",
    },
    "file-version": PKG.version || "1.0.0",
    "product-version": PKG.version || "1.0.0",
  };
  if (hasIcon) rcOptions.icon = icoPath;
  await rcedit(OUT_EXE, rcOptions);

  console.log("[build-exe] 5/5 注入程式與資源至 kknews.exe...");
  const blob = fs.readFileSync(blobPath);
  await inject(OUT_EXE, "NODE_SEA_BLOB", blob, {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const sizeMb = (fs.statSync(OUT_EXE).size / (1024 * 1024)).toFixed(2);
  console.log(`\n✅ 打包完成！輸出檔案：${OUT_EXE} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error("\n❌ 打包失敗：", err?.message || err);
  process.exit(1);
});

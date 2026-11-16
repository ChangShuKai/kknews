const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, execFileSync } = require("child_process");

process.env.KKNEWS_THROW_ON_ENV_ERROR = "1";
delete process.env.VERCEL;
delete process.env.VERCEL_URL;

const args = new Set(process.argv.slice(2));
const noOpen = args.has("--no-open");
const openAdminOnStart = args.has("--admin");

function setConsoleTitle(title) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

function pauseAndExit(code = 1) {
  if (!process.stdin.isTTY || noOpen) {
    process.exit(code);
    return;
  }
  console.log("\n按 Enter 鍵結束...");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("", () => {
    rl.close();
    process.exit(code);
  });
}

function findRegistryAppPath(exeName) {
  if (process.platform !== "win32") return null;
  const regKeys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
  for (const key of regKeys) {
    try {
      const out = execFileSync("reg.exe", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
      if (match && match[1]) {
        const candidate = match[1].trim().replace(/^"|"$/g, "");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

function findDesktopBrowser() {
  const edgeCandidates = [
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    findRegistryAppPath("msedge.exe"),
  ].filter(Boolean);

  for (const p of edgeCandidates) {
    if (fs.existsSync(p)) return { kind: "edge", path: p };
  }

  const chromeCandidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    findRegistryAppPath("chrome.exe"),
  ].filter(Boolean);

  for (const p of chromeCandidates) {
    if (fs.existsSync(p)) return { kind: "chrome", path: p };
  }

  return null;
}

function openAppWindow(url, onManagedWindowClosed) {
  const browser = findDesktopBrowser();
  if (browser) {
    const profileDir = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "KKNews",
      browser.kind === "edge" ? "EdgeProfile" : "ChromeProfile"
    );
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}

    const startedAt = Date.now();
    const child = spawn(
      browser.path,
      [
        `--app=${url}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,860",
      ],
      { detached: false, stdio: "ignore", windowsHide: false }
    );
    child.on("error", () => {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    });
    child.on("exit", () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 2500 && typeof onManagedWindowClosed === "function") {
        onManagedWindowClosed();
      }
    });
    return { mode: browser.kind, child };
  }

  spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { mode: "default-browser", child: null };
}

function getEnvStatusSummary() {
  const hasGoogle = Boolean((process.env.GOOGLE_CLIENT_ID || "").trim());
  const hasMail = Boolean(
    process.env.RESEND_API_KEY ||
    (process.env.SMTP_USER && process.env.SMTP_PASS) ||
    process.env.SENDGRID_API_KEY ||
    process.env.BREVO_API_KEY ||
    process.env.MAIL_WEBHOOK_URL
  );
  const hasTurnstile = Boolean(
    process.env.TURNSTILE_SECRET_KEY ||
    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ||
    process.env.CLOUDFLARE_SECRET_KEY
  );
  return { hasGoogle, hasMail, hasTurnstile };
}

async function main() {
  setConsoleTitle("KKNews 本機桌面伺服器");

  let app;
  try {
    app = require("./server.js");
  } catch (err) {
    console.error("\n[KKNews] 啟動失敗：", err?.message || err);
    pauseAndExit(1);
    return;
  }

  const port = Number(process.env.PORT) || 3000;
  const baseUrl = `http://localhost:${port}`;
  const launchUrl = openAdminOnStart ? `${baseUrl}/adminusercontrol` : baseUrl;

  let server;
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
    } catch {}
    if (server) {
      server.close(() => process.exit(code));
      setTimeout(() => process.exit(code), 1500).unref();
    } else {
      process.exit(code);
    }
  };

  server = app.listen(port, () => {
    const envInfo = getEnvStatusSummary();
    console.log("============================================================");
    console.log("  KKNews 本機桌面伺服器已啟動（無須 Vercel）");
    console.log("============================================================");
    console.log(`  前台首頁：${baseUrl}`);
    console.log(`  管理後台：${baseUrl}/adminusercontrol`);
    console.log("------------------------------------------------------------");
    console.log(`  Google OAuth 登入：${envInfo.hasGoogle ? "✅ 已設定 GOOGLE_CLIENT_ID" : "⚠️ 未設定 GOOGLE_CLIENT_ID（無法使用 Google 登入）"}`);
    console.log(`  後台 2FA 寄信通知：${envInfo.hasMail ? "✅ 已設定寄信通道" : "ℹ️ 未設定 SMTP/Resend（新裝置 OTP 驗證碼將直接顯示於此視窗）"}`);
    console.log(`  Turnstile 驗證  ：${envInfo.hasTurnstile ? "✅ 已設定金鑰" : "ℹ️ 本機開發模式自動放行"}`);
    console.log("------------------------------------------------------------");
    console.log("  快捷鍵：[H] 開啟首頁  [A] 開啟後台管理  [Q] 結束伺服器");
    console.log("============================================================\n");

    if (!noOpen) {
      openAppWindow(launchUrl, () => {
        console.log("\n[KKNews] 桌面視窗已關閉，正在結束本機伺服器...");
        setTimeout(() => shutdown(0), 300);
      });
    }

    if (process.stdin.isTTY && !noOpen) {
      try {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.setRawMode) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("keypress", (_str, key) => {
          if (!key) return;
          if ((key.ctrl && key.name === "c") || key.name === "q") {
            console.log("\n[KKNews] 正在關閉伺服器...");
            shutdown(0);
          } else if (key.name === "h") {
            console.log(`[KKNews] 正在開啟前台視窗: ${baseUrl}`);
            openAppWindow(baseUrl);
          } else if (key.name === "a") {
            console.log(`[KKNews] 正在開啟後台管理視窗: ${baseUrl}/adminusercontrol`);
            openAppWindow(`${baseUrl}/adminusercontrol`);
          }
        });
      } catch {}
    }
  });

  server.on("error", async (err) => {
    if (err && err.code === "EADDRINUSE") {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          console.log(`[KKNews] 偵測到本機伺服器已於 ${baseUrl} 執行中，正在直接開啟桌面視窗...`);
          if (!noOpen) openAppWindow(launchUrl);
          setTimeout(() => process.exit(0), 800);
          return;
        }
      } catch {}
      console.error(`\n[KKNews] 無法啟動：本機埠號 ${port} 已被其他程式佔用。`);
      console.error("請關閉佔用該埠號的程式，或在 .env 中設定其他 PORT 後再試。\n");
      pauseAndExit(1);
      return;
    }
    console.error("\n[KKNews] 伺服器發生錯誤：", err?.message || err);
    pauseAndExit(1);
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

main();

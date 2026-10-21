const crypto = require("crypto");
const pw = process.argv[2];
if (!pw) { console.error("用法: node hash-password.js <密碼>"); process.exit(1); }
const salt = crypto.randomBytes(16).toString("hex");
console.log(`ADMIN_PASSWORD_HASH=${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`);
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString("hex")}`);
console.log(`ADMIN_ACCESS_KEY=${crypto.randomBytes(12).toString("hex")}`);

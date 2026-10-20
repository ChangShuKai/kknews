// 本機測試：node server.js → http://localhost:3000 與 /adminusercontrol
const http = require("http"), fs = require("fs"), path = require("path");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
http.createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  if (p === "/adminusercontrol") p = "/adminusercontrol.html";
  const f = path.join(__dirname, path.normalize(p));
  if (!f.startsWith(__dirname) || !["index.html", "adminusercontrol.html", "config.js"].includes(path.basename(f))) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/plain" }); res.end(d);
  });
}).listen(3000, () => console.log("http://localhost:3000"));

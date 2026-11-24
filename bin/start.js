// npm start: the server as its own process, named by full paths (node's and server.js's), as launch.js starts it. The
// bridge looks for exactly that before it acts on an answer (bridge/hq-bridge.js hqProcess), and npm's own "node server.js"
// names neither.
const path = require("path");
const { spawn } = require("child_process");

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), ...process.argv.slice(2)], { stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
child.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code === null ? 1 : code));

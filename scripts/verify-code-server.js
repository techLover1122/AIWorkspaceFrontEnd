const http = require("node:http");

const host = process.env.CODE_SERVER_HOST || "127.0.0.1";
const port = Number(process.env.CODE_SERVER_PORT || "5522");

const req = http.request(
  {
    host,
    port,
    path: "/",
    method: "GET",
    timeout: 5000,
  },
  (res) => {
    console.log(`[verify] code-server responded with HTTP ${res.statusCode}`);
    process.exit(0);
  }
);

req.on("timeout", () => {
  console.error("[verify] Request timed out.");
  req.destroy();
  process.exit(1);
});

req.on("error", (error) => {
  console.error("[verify] code-server is not reachable.");
  console.error(error.message);
  process.exit(1);
});

req.end();

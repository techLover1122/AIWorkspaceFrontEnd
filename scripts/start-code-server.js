const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const host = process.env.CODE_SERVER_HOST || "0.0.0.0";
const port = process.env.CODE_SERVER_PORT || "5522";
const workspace =
  process.env.CODE_SERVER_WORKSPACE || "./workspaces/project-1";
const auth = process.env.CODE_SERVER_AUTH || "password";
const password = process.env.CODE_SERVER_PASSWORD || "change-me";

const resolvedWorkspace = path.resolve(process.cwd(), workspace);
const userDataDir = path.resolve(process.cwd(), "config/code-server/user-data");
const bindAddr = `${host}:${port}`;
const isWindows = process.platform === "win32";
const command = isWindows ? "code-server.cmd" : "code-server";

fs.mkdirSync(userDataDir, { recursive: true });

const args = [
  "--bind-addr",
  bindAddr,
  "--auth",
  auth,
  "--user-data-dir",
  userDataDir,
  resolvedWorkspace,
];

const env = {
  ...process.env,
  PASSWORD: password,
};

console.log(`[code-server] bind: ${bindAddr}`);
console.log(`[code-server] workspace: ${resolvedWorkspace}`);
console.log(`[code-server] auth: ${auth}`);
console.log(`[code-server] user data: ${userDataDir}`);

const child = spawn(command, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  env,
  shell: isWindows,
});

child.on("error", (error) => {
  console.error(
    "[code-server] Failed to start. Ensure code-server is installed globally and in PATH."
  );
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

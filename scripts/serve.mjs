#!/usr/bin/env node
/**
 * Runs the Rust backend with the right working directory and environment,
 * regardless of which shell started it.
 *
 * `npm run serve` used to be `cd backend && cargo run`, which fails with
 * "sh: 1: cargo: not found" when npm's /bin/sh does not source ~/.bashrc
 * (where rustup puts ~/.cargo/bin on PATH). This script finds cargo itself and
 * points FRONTEND_DIR / DATA_DIR at the repo root so the server works whether
 * it is started from the repo root or from backend/.
 *
 *   node scripts/serve.mjs              # cargo run
 *   node scripts/serve.mjs --release    # cargo run --release
 *   node scripts/serve.mjs --build-only # cargo build, no server
 *   node scripts/serve.mjs --smoke      # start, run scripts/smoke.sh, stop
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend");
const args = process.argv.slice(2);

function findCargo() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [
    process.env.CARGO,
    path.join(home, ".cargo", "bin", "cargo"),
    "/usr/local/cargo/bin/cargo",
    "/opt/rust/bin/cargo",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  if (which.status === 0) return "cargo";
  return null;
}

const cargo = findCargo();
if (!cargo) {
  console.error(
    [
      "error: cargo was not found.",
      "",
      "The Rust backend needs the Rust toolchain. Install it with:",
      "",
      "    curl https://sh.rustup.rs -sSf | sh",
      "",
      "then open a new terminal (or run: . \"$HOME/.cargo/env\") and try again.",
      "If cargo lives somewhere unusual, set CARGO=/path/to/cargo.",
    ].join("\n"),
  );
  process.exit(1);
}

const env = {
  ...process.env,
  FRONTEND_DIR: process.env.FRONTEND_DIR ?? path.join(root, "frontend"),
  DATA_DIR: process.env.DATA_DIR ?? path.join(root, "data"),
};

const cargoArgs = ["run", "--manifest-path", path.join(backend, "Cargo.toml")];
if (args.includes("--release")) cargoArgs.push("--release");

if (args.includes("--build-only")) {
  const r = spawnSync(cargo, ["build", ...cargoArgs.slice(1)], { cwd: root, env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (args.includes("--smoke")) {
  const server = spawn(cargo, cargoArgs, { cwd: root, env, stdio: "inherit" });
  const port = process.env.PORT ?? "8080";
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const ready = async () => {
    try {
      const r = await fetch(`${base}/api/health`);
      return r.ok;
    } catch {
      return false;
    }
  };
  while (!(await ready())) {
    if (Date.now() - started > 180_000) {
      console.error("error: server did not become ready in time");
      server.kill();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const smoke = spawnSync("bash", [path.join(root, "scripts", "smoke.sh")], {
    cwd: root,
    env: { ...process.env, BASE: base },
    stdio: "inherit",
  });
  server.kill("SIGTERM");
  process.exit(smoke.status ?? 1);
}

const server = spawn(cargo, cargoArgs, { cwd: root, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.kill(sig));
}
server.on("exit", (code) => process.exit(code ?? 0));

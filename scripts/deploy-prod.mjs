#!/usr/bin/env node
// Deploys the full Cloudflare OS stack to production.
//
// ALL instance config lives in deploy-config.json (committed).
// Only two secrets required from the environment:
//   CLOUDFLARE_ACCOUNT_ID   — Cloudflare account ID (wrangler reads this)
//   CLOUDFLARE_API_TOKEN    — API token (Workers:Edit, KV:Edit, R2:Edit, AI:Read)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

// ---------------------------------------------------------------------------
// Load deploy-config.json — single source of truth for this instance
// ---------------------------------------------------------------------------
const CONFIG = JSON.parse(readFileSync(join(ROOT, "deploy-config.json"), "utf8"));

const PUBLIC_BASE_URL       = CONFIG.publicBaseUrl;
const KV_BLUEPRINTS_ID      = CONFIG.kvBlueprintsId;
const KV_AVATARS_ID         = CONFIG.kvAvatarsId;
const R2_BLUEPRINT_CONTENT  = CONFIG.r2BlueprintContent;
const ADMINS                = JSON.stringify(CONFIG.admins ?? []);
const AUTH_GATEKEEPERS      = CONFIG.authGatekeepers ?? "";
const BACKEND_EXTRA_VARS    = CONFIG.backendExtraVars ?? {};
const GK_NAME_OVERRIDES     = CONFIG.gatekeeperNameOverrides ?? {};
const ACTIVE_GK_LIST        = CONFIG.activeGatekeepers ?? "";
const ACTIVE_GATEKEEPERS    = ACTIVE_GK_LIST
  ? ACTIVE_GK_LIST.split(",").map(s => s.trim()).filter(Boolean)
  : null; // null = deploy ALL discovered gatekeepers

// ---------------------------------------------------------------------------
// Env validation — only secrets need to come from the environment
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
requireEnv("CLOUDFLARE_ACCOUNT_ID");
requireEnv("CLOUDFLARE_API_TOKEN");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n▶ [${label}] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd });
}
function wrangler(label, configPath, cwd) {
  run(label, "pnpm", ["exec", "wrangler", "deploy", "--config", configPath], cwd);
}
function pkgDir(name) { return join(PACKAGES_DIR, name); }
function readWrangler(name) {
  return parseJsonc(readFileSync(join(pkgDir(name), "wrangler.jsonc"), "utf8"), [], { allowTrailingComma: true });
}
function writeTmp(name, config) {
  const p = join(pkgDir(name), "wrangler.prod.generated.json");
  writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}
function cleanTmp(name) {
  rmSync(join(pkgDir(name), "wrangler.prod.generated.json"), { force: true });
}
function bindingName(pkgName) {
  return pkgName.toUpperCase().replace(/-/g, "_");
}
function deployedName(pkgName) {
  return GK_NAME_OVERRIDES[pkgName] ?? readWrangler(pkgName).name ?? pkgName;
}

// ---------------------------------------------------------------------------
// Gatekeeper discovery
// ---------------------------------------------------------------------------
const allGatekeepers = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.startsWith("gatekeeper-"))
  .map(e => e.name)
  .sort();

const gatekeepers = ACTIVE_GATEKEEPERS ?? allGatekeepers;
const gkBindings = gatekeepers.map(pkg => ({ pkg, workerName: deployedName(pkg) }));

console.log("\n=== Cloudflare OS — Production Deploy ===");
console.log(`PUBLIC_BASE_URL:    ${PUBLIC_BASE_URL}`);
console.log(`AUTH_GATEKEEPERS:   ${AUTH_GATEKEEPERS}`);
console.log(`Gatekeepers (${gkBindings.length}): ${gkBindings.map(g => `${g.pkg}→${g.workerName}`).join(", ")}`);
console.log(`ADMINS:             ${ADMINS}`);

// ---------------------------------------------------------------------------
// Step 1 — Install
// ---------------------------------------------------------------------------
console.log("\n=== Step 1: Install ===");
run("install", "pnpm", ["install"]);

// ---------------------------------------------------------------------------
// Step 2 — Build typed-storage
// ---------------------------------------------------------------------------
console.log("\n=== Step 2: typed-storage ===");
run("typed-storage", "pnpm", ["--filter", "@gadgets/typed-storage", "build"]);

// ---------------------------------------------------------------------------
// Step 3 — Build frontend
// ---------------------------------------------------------------------------
console.log("\n=== Step 3: Frontend ===");
run("frontend", "pnpm", ["--filter", "@gadgets/workshop-frontend", "exec", "vite", "build"]);

// ---------------------------------------------------------------------------
// Step 4 — Deploy gatekeepers
// ---------------------------------------------------------------------------
console.log("\n=== Step 4: Gatekeepers ===");
for (const { pkg, workerName } of gkBindings) {
  const dir = pkgDir(pkg);
  console.log(`\n  → ${pkg} (${workerName})`);
  // Some gatekeepers need their configurator UI built first (generates src/generated/app.txt)
  const { existsSync: _existsSync } = require('node:fs');
  if (_existsSync(join(pkgDir(pkg), 'src/configurator'))) {
    run(pkg + ':configurator', 'node', ['../../scripts/build-gatekeeper-configurator.mjs', '.'], dir);
  }
  run(pkg, "pnpm", ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"], dir);
  const cfg = readWrangler(pkg);
  cfg.name = workerName;
  // Strip build command so wrangler doesn't re-run it
  delete cfg.build;
  const tmp = writeTmp(pkg, cfg);
  try { wrangler(pkg, "wrangler.prod.generated.json", dir); }
  finally { cleanTmp(pkg); }
}

// ---------------------------------------------------------------------------
// Step 5 — Build + deploy backend
// ---------------------------------------------------------------------------
console.log("\n=== Step 5: Backend (josh-os-backend) ===");
const backendDir = pkgDir("workshop-backend");
run("backend:format-blueprints", "node", ["scripts/build-format-blueprints.mjs"], backendDir);
run("backend:browser-runtime",   "node", ["build-browser-runtime.mjs"], backendDir);
run("backend:capnweb",           "pnpm", ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"], backendDir);

const backendCfg = readWrangler("workshop-backend");
backendCfg.name = "josh-os-backend";
delete backendCfg.build;
backendCfg.kv_namespaces = [
  { binding: "BLUEPRINTS", id: KV_BLUEPRINTS_ID },
  { binding: "AVATARS",    id: KV_AVATARS_ID },
];
backendCfg.r2_buckets = [{ binding: "BLUEPRINT_CONTENT", bucket_name: R2_BLUEPRINT_CONTENT }];
backendCfg.ai         = { binding: "WORKERS_AI" };
backendCfg.vars = {
  ...(backendCfg.vars ?? {}),
  PUBLIC_BASE_URL,
  ADMINS,
  ...(AUTH_GATEKEEPERS ? { AUTH_GATEKEEPERS } : {}),
  ...BACKEND_EXTRA_VARS,
};
backendCfg.services = gkBindings.map(({ pkg, workerName }) => {
  const b = { binding: bindingName(pkg), service: workerName, entrypoint: "GatekeeperVendor" };
  if (pkg === "gatekeeper-context") b.props = { sharingDomain: PUBLIC_BASE_URL };
  return b;
});

writeTmp("workshop-backend", backendCfg);
try { wrangler("backend", "wrangler.prod.generated.json", backendDir); }
finally { cleanTmp("workshop-backend"); }

// ---------------------------------------------------------------------------
// Step 6 — Deploy router
// ---------------------------------------------------------------------------
console.log("\n=== Step 6: Router (josh-os) ===");
const routerDir = pkgDir("router");
run("router:capnweb", "pnpm", ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"], routerDir);

const routerCfg = readWrangler("router");
delete routerCfg.build;
routerCfg.services = [
  { binding: "WORKSHOP_BACKEND", service: "josh-os-backend" },
  ...gkBindings.map(({ pkg, workerName }) => ({ binding: bindingName(pkg), service: workerName })),
];
writeTmp("router", routerCfg);
try { wrangler("router", "wrangler.prod.generated.json", routerDir); }
finally { cleanTmp("router"); }

console.log(`\n✅ Deployed → ${PUBLIC_BASE_URL}`);

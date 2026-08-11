#!/usr/bin/env node

// Deploys the full Cloudflare OS stack directly via wrangler.
//
// Discovers all gatekeeper packages, resolves their deployed worker names,
// injects service bindings into the backend and router, and deploys every
// worker in order: gatekeepers → backend → router.
//
// Required env vars:
//   CLOUDFLARE_ACCOUNT_ID   — Cloudflare account ID (wrangler reads this)
//   CLOUDFLARE_API_TOKEN    — API token (Workers:Edit, KV:Edit, R2:Edit, AI:Read)
//   PUBLIC_BASE_URL         — production origin e.g. https://josh-os.josh-demo-account.workers.dev
//   KV_BLUEPRINTS_ID        — KV namespace ID for BLUEPRINTS binding
//   KV_AVATARS_ID           — KV namespace ID for AVATARS binding
//
// Optional:
//   R2_BLUEPRINT_CONTENT    — R2 bucket name (default: josh-os-blueprint-content)
//   SKIP_GATEKEEPERS        — comma-separated package names to skip deploying (already current)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

requireEnv("CLOUDFLARE_ACCOUNT_ID");
requireEnv("CLOUDFLARE_API_TOKEN");
const PUBLIC_BASE_URL = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
const KV_BLUEPRINTS_ID = requireEnv("KV_BLUEPRINTS_ID");
const KV_AVATARS_ID    = requireEnv("KV_AVATARS_ID");
const R2_BLUEPRINT_CONTENT = process.env.R2_BLUEPRINT_CONTENT ?? "josh-os-blueprint-content";
const SKIP_GK = new Set((process.env.SKIP_GATEKEEPERS ?? "").split(",").filter(Boolean));

// ---------------------------------------------------------------------------
// Name mapping — maps package name → deployed worker name where they differ.
// Packages not in this map are deployed using their wrangler.jsonc name field.
// ---------------------------------------------------------------------------
const DEPLOYED_NAME = {
  "gatekeeper-context":   "josh-os-gk-context",
  "gatekeeper-scheduler": "josh-os-gk-scheduler",
};

function deployedName(pkgName, wranglerName) {
  return DEPLOYED_NAME[pkgName] ?? wranglerName;
}

// "gatekeeper-workers-ai-image" → "GATEKEEPER_WORKERS_AI_IMAGE"
function bindingName(pkgName) {
  return pkgName.toUpperCase().replace(/-/g, "_");
}

function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n▶ [${label}] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd });
}

function wranglerDeploy(label, configPath, cwd) {
  run(label, "pnpm", ["exec", "wrangler", "deploy", "--config", configPath], cwd);
}

function readWrangler(pkgName) {
  const p = join(PACKAGES_DIR, pkgName, "wrangler.jsonc");
  return parseJsonc(readFileSync(p, "utf8"), [], { allowTrailingComma: true });
}

function writeTmp(pkgName, config) {
  const p = join(PACKAGES_DIR, pkgName, "wrangler.prod.generated.json");
  writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

function cleanTmp(pkgName) {
  rmSync(join(PACKAGES_DIR, pkgName, "wrangler.prod.generated.json"), { force: true });
}

// Discover all gatekeeper packages
const gatekeepers = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.startsWith("gatekeeper-"))
  .map(e => e.name)
  .sort();

// Build the list of {pkgName, deployedWorkerName} for service binding generation
const gkBindings = gatekeepers.map(pkg => {
  const cfg = readWrangler(pkg);
  return { pkg, workerName: deployedName(pkg, cfg.name) };
});

console.log("=== Cloudflare OS — Production Deploy ===");
console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
console.log("Gatekeepers:", gkBindings.map(g => `${g.pkg}→${g.workerName}`).join(", "));

// ---------------------------------------------------------------------------
// Step 1 — Install
// ---------------------------------------------------------------------------
console.log("\n=== Step 1: Install dependencies ===");
run("install", "pnpm", ["install", "--frozen-lockfile"]);

// ---------------------------------------------------------------------------
// Step 2 — Build typed-storage (backend requires its dist output)
// ---------------------------------------------------------------------------
console.log("\n=== Step 2: Build typed-storage ===");
run("typed-storage", "pnpm", ["--filter", "@gadgets/typed-storage", "build"]);

// ---------------------------------------------------------------------------
// Step 3 — Build frontend
// ---------------------------------------------------------------------------
console.log("\n=== Step 3: Build frontend ===");
run("frontend", "pnpm", ["--filter", "@gadgets/workshop-frontend", "exec", "vite", "build"]);

// ---------------------------------------------------------------------------
// Step 4 — Build + deploy each gatekeeper (unless skipped)
// ---------------------------------------------------------------------------
console.log("\n=== Step 4: Deploy gatekeepers ===");
for (const { pkg, workerName } of gkBindings) {
  if (SKIP_GK.has(pkg)) {
    console.log(`  ↷ skipping ${pkg} (SKIP_GATEKEEPERS)`);
    continue;
  }
  const dir = join(PACKAGES_DIR, pkg);
  console.log(`\n  → ${pkg} (${workerName})`);

  // Build the validated worker bundle
  run(pkg, "pnpm", ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"], dir);

  // Generate wrangler config with the correct deployed name
  const cfg = readWrangler(pkg);
  const prodCfg = { ...cfg, name: workerName };
  const tmpPath = writeTmp(pkg, prodCfg);
  try {
    wranglerDeploy(pkg, "wrangler.prod.generated.json", dir);
  } finally {
    cleanTmp(pkg);
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Build + deploy workshop-backend (josh-os-backend)
// ---------------------------------------------------------------------------
console.log("\n=== Step 5: Deploy backend (josh-os-backend) ===");
const backendDir = join(PACKAGES_DIR, "workshop-backend");
run("backend:build", "pnpm", ["run", "build:worker"], backendDir);

const backendCfg = readWrangler("workshop-backend");
backendCfg.name = "josh-os-backend";
backendCfg.kv_namespaces = [
  { binding: "BLUEPRINTS", id: KV_BLUEPRINTS_ID },
  { binding: "AVATARS",    id: KV_AVATARS_ID    },
];
backendCfg.r2_buckets   = [{ binding: "BLUEPRINT_CONTENT", bucket_name: R2_BLUEPRINT_CONTENT }];
backendCfg.ai           = { binding: "WORKERS_AI" };
backendCfg.vars         = { ...(backendCfg.vars ?? {}), PUBLIC_BASE_URL };
backendCfg.services     = gkBindings.map(({ pkg, workerName }) => {
  const binding = { binding: bindingName(pkg), service: workerName, entrypoint: "GatekeeperVendor" };
  if (pkg === "gatekeeper-context") binding.props = { sharingDomain: PUBLIC_BASE_URL };
  return binding;
});

const backendTmp = writeTmp("workshop-backend", backendCfg);
try {
  wranglerDeploy("backend", "wrangler.prod.generated.json", backendDir);
} finally {
  cleanTmp("workshop-backend");
}

// ---------------------------------------------------------------------------
// Step 6 — Deploy router (josh-os)
// ---------------------------------------------------------------------------
console.log("\n=== Step 6: Deploy router (josh-os) ===");
const routerDir = join(PACKAGES_DIR, "router");
run("router:build", "pnpm", ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"], routerDir);

const routerCfg = readWrangler("router");
// Router already has "name": "josh-os" in wrangler.jsonc — no override needed.
// Inject the full set of gatekeeper bindings (HTTP forwarding, default entrypoint).
routerCfg.services = [
  { binding: "WORKSHOP_BACKEND", service: "josh-os-backend" },
  ...gkBindings.map(({ pkg, workerName }) => ({ binding: bindingName(pkg), service: workerName })),
];

const routerTmp = writeTmp("router", routerCfg);
try {
  wranglerDeploy("router", "wrangler.prod.generated.json", routerDir);
} finally {
  cleanTmp("router");
}

console.log("\n✅ All workers deployed.");
console.log(`   Live at: ${PUBLIC_BASE_URL}`);

#!/usr/bin/env node

// Deploys the full Cloudflare OS stack directly via wrangler — no separate deploy service needed.
//
// This script replicates what the internal generate-wrangler-prod.js does: it discovers all
// gatekeeper packages, injects service bindings into the backend and router, and deploys every
// worker in the correct order (gatekeepers → backend → router).
//
// Required env vars:
//   CLOUDFLARE_ACCOUNT_ID   — Cloudflare account ID
//   CLOUDFLARE_API_TOKEN    — API token (Workers:Edit, KV:Edit, R2:Edit, AI:Read)
//   PUBLIC_BASE_URL         — production origin, e.g. https://os.example.com
//   KV_BLUEPRINTS_ID        — KV namespace ID for the BLUEPRINTS binding
//   KV_AVATARS_ID           — KV namespace ID for the AVATARS binding
//
// Optional env vars:
//   R2_BLUEPRINT_CONTENT    — R2 bucket name (default: gadgets-blueprint-content)
//   SKIP_PACKAGES           — comma-separated package names to skip

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const PUBLIC_BASE_URL = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
const KV_BLUEPRINTS_ID = requireEnv("KV_BLUEPRINTS_ID");
const KV_AVATARS_ID    = requireEnv("KV_AVATARS_ID");
const R2_BLUEPRINT_CONTENT = process.env.R2_BLUEPRINT_CONTENT ?? "gadgets-blueprint-content";
// Override to deploy workshop-backend under a custom name (e.g. "josh-os-backend" for this instance).
// The router's WORKSHOP_BACKEND service binding is updated to match automatically.
const BACKEND_WORKER_NAME = process.env.BACKEND_WORKER_NAME ?? "workshop-backend";
const SKIP = new Set((process.env.SKIP_PACKAGES ?? "").split(",").filter(Boolean));

// Validate CLOUDFLARE_* are present (wrangler reads them directly from env).
requireEnv("CLOUDFLARE_ACCOUNT_ID");
requireEnv("CLOUDFLARE_API_TOKEN");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(label, cmd, args, cwd = ROOT) {
  console.log(`\n▶ [${label}] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd });
}

function wrangler(label, args, cwd) {
  // Use the locally pinned wrangler from node_modules.
  run(label, "pnpm", ["exec", "wrangler", ...args], cwd);
}

function pkgDir(name) {
  return join(PACKAGES_DIR, name);
}

function readWrangler(name) {
  const p = join(pkgDir(name), "wrangler.jsonc");
  return parseJsonc(readFileSync(p, "utf8"), [], { allowTrailingComma: true });
}

function writeTempWrangler(name, config) {
  const p = join(pkgDir(name), "wrangler.prod.generated.json");
  writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

function removeTempWrangler(name) {
  const p = join(pkgDir(name), "wrangler.prod.generated.json");
  rmSync(p, { force: true });
}

// "gatekeeper-workers-ai-image" → "GATEKEEPER_WORKERS_AI_IMAGE"
function bindingName(pkgName) {
  return pkgName.toUpperCase().replace(/-/g, "_");
}

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------
const allGatekeepers = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.startsWith("gatekeeper-"))
  .map(e => e.name)
  .sort();

const gatekeepers = allGatekeepers.filter(gk => !SKIP.has(gk));
console.log(`\nGatekeepers (${gatekeepers.length}): ${gatekeepers.join(", ")}`);
console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);

// ---------------------------------------------------------------------------
// Step 1 — Install dependencies
// ---------------------------------------------------------------------------
console.log("\n=== Step 1: Install dependencies ===");
run("install", "pnpm", ["install", "--frozen-lockfile"]);

// ---------------------------------------------------------------------------
// Step 2 — Build typed-storage (backend imports its dist output)
// ---------------------------------------------------------------------------
console.log("\n=== Step 2: Build typed-storage ===");
run("typed-storage", "pnpm", ["--filter", "@gadgets/typed-storage", "build"]);

// ---------------------------------------------------------------------------
// Step 3 — Build frontend
// ---------------------------------------------------------------------------
console.log("\n=== Step 3: Build frontend ===");
run("frontend", "pnpm", ["--filter", "@gadgets/workshop-frontend", "exec", "vite", "build"]);

// ---------------------------------------------------------------------------
// Step 4 — Deploy each gatekeeper
// ---------------------------------------------------------------------------
console.log("\n=== Step 4: Deploy gatekeepers ===");
for (const gk of gatekeepers) {
  const dir = pkgDir(gk);
  console.log(`\n  → ${gk}`);
  // capnweb-validate generates .wrangler/validate (the wrangler main entry).
  run(gk, "pnpm", ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"], dir);
  wrangler(gk, ["deploy"], dir);
}

// ---------------------------------------------------------------------------
// Step 5 — Build + deploy workshop-backend (with injected bindings)
// ---------------------------------------------------------------------------
console.log("\n=== Step 5: Deploy workshop-backend ===");
const backendDir = pkgDir("workshop-backend");

// Build the validated worker bundle first.
run("backend:build", "pnpm", ["run", "build:worker"], backendDir);

// Read the static wrangler.jsonc and patch in all dynamic bindings.
const backendConfig = readWrangler("workshop-backend");

// KV namespaces — replace preview_id placeholders with real IDs.
backendConfig.kv_namespaces = [
  { binding: "BLUEPRINTS", id: KV_BLUEPRINTS_ID },
  { binding: "AVATARS",    id: KV_AVATARS_ID    },
];

// R2 bucket.
backendConfig.r2_buckets = [
  { binding: "BLUEPRINT_CONTENT", bucket_name: R2_BLUEPRINT_CONTENT },
];

// Workers AI binding (every backend instance gets this).
backendConfig.ai = { binding: "WORKERS_AI" };

// Instance vars.
backendConfig.vars = { ...(backendConfig.vars ?? {}), PUBLIC_BASE_URL };

// Gatekeeper service bindings (GATEKEEPER_* → each gatekeeper's GatekeeperVendor entrypoint).
backendConfig.services = gatekeepers.map(gk => {
  const binding = { binding: bindingName(gk), service: gk, entrypoint: "GatekeeperVendor" };
  // gatekeeper-context requires a sharingDomain prop so it namespaces data per workshop instance.
  if (gk === "gatekeeper-context") {
    binding.props = { sharingDomain: PUBLIC_BASE_URL };
  }
  return binding;
});

const backendTmp = writeTempWrangler("workshop-backend", backendConfig);
try {
  wrangler("backend", ["deploy", "--config", "wrangler.prod.generated.json", "--name", BACKEND_WORKER_NAME], backendDir);
} finally {
  removeTempWrangler("workshop-backend");
}

// ---------------------------------------------------------------------------
// Step 6 — Deploy router (with gatekeeper HTTP-forward bindings + assets)
// ---------------------------------------------------------------------------
console.log("\n=== Step 6: Deploy router ===");
const routerDir = pkgDir("router");
const routerConfig = readWrangler("router");

// Static backend binding + all gatekeeper bindings (default entrypoint for HTTP forwarding).
routerConfig.services = [
  { binding: "WORKSHOP_BACKEND", service: BACKEND_WORKER_NAME },
  ...gatekeepers.map(gk => ({ binding: bindingName(gk), service: gk })),
];

const routerTmp = writeTempWrangler("router", routerConfig);
try {
  wrangler("router", ["deploy", "--config", "wrangler.prod.generated.json"], routerDir);
} finally {
  removeTempWrangler("router");
}

console.log("\n✅ All workers deployed to production.");
console.log(`   Live at: ${PUBLIC_BASE_URL}`);

import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-github",
  entrypoint: ".wrangler/validate/src/github.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
  // Without this the OAuth redirect falls back to http://localhost:8787/gatekeeper/github.
  env: {
    BASE_URL: bindings.text("https://os.crosby.family/gatekeeper/github"),
  },
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GitHubGatekeeperImpl"] },
  { tag: "v1", new_sqlite_classes: ["GitHubHookDriver"] },
];

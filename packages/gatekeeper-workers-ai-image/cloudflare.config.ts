import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-workers-ai-image",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  entrypoint: ".wrangler/validate/src/worker.ts",
  observability: OBSERVABILITY,
  env: {
    // Text-to-image inference. Declared by the gatekeeper itself, not inherited from the backend.
    WORKERS_AI: bindings.ai(),
    // Public URL of this worker; generateImageUrl() returns links under it.
    IMAGE_WORKER_URL: bindings.text("https://gatekeeper-workers-ai-image.josh-demo-account.workers.dev"),
  },
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["ImageGatekeeper"] },
];

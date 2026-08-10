/* eslint-disable */
// Workers AI image gatekeeper — hand-written; regenerate with `wrangler types` after first deploy.
// Runtime types generated with workerd@1.20260801.1 2026-02-02 allow_irrevocable_stub_storage
interface __BaseEnv_Env {
  WORKERS_AI: Ai;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/worker");
    durableNamespaces: "ImageGatekeeper";
  }
  interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}

/* eslint-disable */
// Workers AI image gatekeeper — regenerate with `wrangler types` after first deploy.
interface __BaseEnv_Env {
  WORKERS_AI: Ai;
  IMAGE_GATEKEEPER: DurableObjectNamespace;
  IMAGE_WORKER_URL: string;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/worker");
    durableNamespaces: "ImageGatekeeper";
  }
  interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}

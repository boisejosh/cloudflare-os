/* eslint-disable */
// Web search gatekeeper — regenerate with `wrangler types` after first deploy.
interface __BaseEnv_Env {
  TAVILY_API_KEY: string;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/worker");
    durableNamespaces: "WebSearchGatekeeper";
  }
  interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}

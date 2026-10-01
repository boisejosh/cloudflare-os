import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import TYPES_CODE from "./types.txt";
import type { SearchOptions, SearchResponse, WebSearchSession } from "./types.js";

const WEB_SEARCH_LOGO = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M229.66 218.34l-50.07-50.07a88.11 88.11 0 1 0-11.31 11.31l50.06 50.07a8 8 0 0 0 11.32-11.31ZM40 112a72 72 0 1 1 72 72 72.08 72.08 0 0 1-72-72Z'/>" +
      "</svg>",
    ),
};

const TAVILY_API = "https://api.tavily.com/search";

type AccountProps = { accountId: string };

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

@validateRpc()
class WebSearchSessionImpl extends RpcTarget implements WebSearchSession {
  readonly #apiKey: string;

  constructor(apiKey: string) {
    super();
    this.#apiKey = apiKey;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const {
      maxResults = 5,
      searchDepth = "basic",
      includeDomains = [],
    } = options;

    const body: Record<string, unknown> = {
      query,
      search_depth: searchDepth,
      include_answer: true,
      max_results: Math.min(Math.max(1, maxResults), 10),
    };
    if (includeDomains.length > 0) body.include_domains = includeDomains;

    const response = await fetch(TAVILY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Tavily search failed (${response.status}): ${text}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;

    return {
      query,
      answer: typeof data.answer === "string" && data.answer.length > 0 ? data.answer : null,
      results: (data.results ?? []).map((r: any) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.content ?? "",
        score: typeof r.score === "number" ? r.score : 0,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper DO
// ---------------------------------------------------------------------------

@validateRpc()
export class WebSearchGatekeeper
  extends DurableObject<Cloudflare.Env, AccountProps>
  implements Gatekeeper<WebSearchSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: "web-search://tavily",
      title: "Web Search",
      snippet: "Search the internet via Tavily and get AI-synthesised answers.",
      suggestedBindingName: "WEB_SEARCH",
      tsType: "WebSearchSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<WebSearchSession> {
    approvalQueue[Symbol.dispose]?.();
    return new WebSearchSessionImpl(this.env.TAVILY_API_KEY);
  }

  async getAgentCatalog(
    _request: AgentCatalogRequest,
    _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("Web Search implements no actions.");
  }
  rejectAction(_action: number): Promise<void> {
    throw new Error("Web Search implements no actions.");
  }
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Web Search implements no actions.");
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

@validateRpc()
export class WebSearchAccount
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Web Search",
      avatar: WEB_SEARCH_LOGO,
      singleton: { tsType: "WebSearchSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebSearchSession>>> {
    return this.ctx.exports.WebSearchGatekeeper({ props: this.ctx.props });
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Web Search has no URL-addressed resources.");
  }
  startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Web Search has no URL-addressed resources.");
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {}
  reconnect(): Promise<{ url: string }> {
    throw new Error("Web Search is auto-provisioned and has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebSearchVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

@validateRpc()
export class WebSearchVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Web Search",
      url: "https://tavily.com",
      logo: WEB_SEARCH_LOGO,
      color: "#0070F3",
      tagline: "Search the internet from your workspace",
      description:
        "Gives every workspace agent access to real-time web search via Tavily. " +
        "Returns AI-synthesised answers and ranked results with snippets. " +
        "Combine with the built-in webFetch tool to read full pages.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebSearchAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Web Search is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

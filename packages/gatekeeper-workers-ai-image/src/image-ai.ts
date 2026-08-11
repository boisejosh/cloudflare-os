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
import type { GeneratedImage, GenerateImageOptions, ImageSession } from "./types.js";

const IMAGE_AI_LOGO = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M216 40H40a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a" +
        "16 16 0 0 0-16-16ZM40 56h176v102.75l-26.07-26.06a16 16 0 0 0-22.63 0l-20 20-44-44a16 " +
        "16 0 0 0-22.62 0L40 149.37Zm176 144H69.37l68-68 44 44a8 8 0 0 0 11.31 0l25.38-25.37 " +
        "L240 172.69Z'/><circle cx='156' cy='100' r='12'/>" +
      "</svg>",
    ),
};

const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

type AccountProps = { accountId: string };

interface StoredImage {
  data: string;      // base64 PNG
  expiresAt: number; // unix ms
}

// Shared model runner — handles both { image: string } and ReadableStream responses.
async function runModel(ai: Ai, prompt: string, options: GenerateImageOptions): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (ai as any).run(model, {
    prompt,
    ...(options.steps !== undefined ? { num_steps: options.steps, steps: options.steps } : {}),
  });
  if (result && typeof (result as { image?: unknown }).image === "string") {
    return (result as { image: string }).image;
  }
  const buf = await new Response(result as ReadableStream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

@validateRpc()
class ImageSessionImpl extends RpcTarget implements ImageSession {
  readonly #ai: Ai;
  readonly #storage: DurableObjectStorage;
  readonly #doIdString: string;
  readonly #workerUrl: string;

  constructor(ai: Ai, storage: DurableObjectStorage, doIdString: string, workerUrl: string) {
    super();
    this.#ai = ai;
    this.#storage = storage;
    this.#doIdString = doIdString;
    this.#workerUrl = workerUrl;
  }

  async generateImage(prompt: string, options: GenerateImageOptions = {}): Promise<GeneratedImage> {
    const data = await runModel(this.#ai, prompt, options);
    return { data, mimeType: "image/png", prompt };
  }

  async generateImageUrl(prompt: string, options: GenerateImageOptions = {}): Promise<string> {
    const data = await runModel(this.#ai, prompt, options);
    const imageId = crypto.randomUUID();
    const expiresAt = Date.now() + 60 * 60 * 1000;
    await this.#storage.put(`img:${imageId}`, { data, expiresAt } satisfies StoredImage);
    return `${this.#workerUrl}/img/${this.#doIdString}/${imageId}`;
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper DO
// ---------------------------------------------------------------------------

@validateRpc()
export class ImageGatekeeper
  extends DurableObject<Cloudflare.Env, AccountProps>
  implements Gatekeeper<ImageSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: "workers-ai://image",
      title: "AI Image Generation",
      snippet: "Generate images from text prompts using Workers AI.",
      suggestedBindingName: "IMAGE_AI",
      tsType: "ImageSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<ImageSession> {
    approvalQueue[Symbol.dispose]?.();
    return new ImageSessionImpl(
      this.env.WORKERS_AI,
      this.ctx.storage,
      this.ctx.id.toString(),
      this.env.IMAGE_WORKER_URL,
    );
  }

  @skipRpcValidation()
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const imageId = pathname.split("/").pop();
    if (!imageId) return new Response("Not found", { status: 404 });
    const stored = await this.ctx.storage.get<StoredImage>(`img:${imageId}`);
    if (!stored || stored.expiresAt < Date.now()) {
      return new Response("Image not found or expired", { status: 404 });
    }
    const bytes = Uint8Array.from(atob(stored.data), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
    });
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
    throw new Error("AI Image Generation implements no actions.");
  }
  rejectAction(_action: number): Promise<void> {
    throw new Error("AI Image Generation implements no actions.");
  }
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("AI Image Generation implements no actions.");
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

@validateRpc()
export class ImageAccount
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "AI Image Generation",
      avatar: IMAGE_AI_LOGO,
      singleton: { tsType: "ImageSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ImageSession>>> {
    return this.ctx.exports.ImageGatekeeper({ props: this.ctx.props });
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return []; }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("AI Image Generation has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("AI Image Generation has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {}
  reconnect(): Promise<{ url: string }> {
    throw new Error("AI Image Generation is auto-provisioned.");
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ImageVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

@validateRpc()
export class ImageVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{}

// ---------------------------------------------------------------------------
// Vendor — routes /img/* HTTP requests to the correct DO
// ---------------------------------------------------------------------------

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "AI Image Generation",
      url: "https://developers.cloudflare.com/workers-ai/",
      logo: IMAGE_AI_LOGO,
      color: "#F6821F",
      tagline: "Generate images from text using Workers AI",
      description:
        "Use Cloudflare Workers AI to generate images from text prompts. " +
        "No external API keys required — uses your account's Workers AI allocation.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = pathname.match(/^\/img\/([a-f0-9]+)\/([a-zA-Z0-9-]+)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const [, doIdHex, imageId] = match;
    try {
      const doId = this.env.IMAGE_GATEKEEPER.idFromString(doIdHex);
      const stub = this.env.IMAGE_GATEKEEPER.get(doId);
      return stub.fetch(new Request(`http://do/img/${doIdHex}/${imageId}`));
    } catch {
      return new Response("Invalid image ID", { status: 400 });
    }
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.ImageAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("AI Image Generation is auto-provisioned.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

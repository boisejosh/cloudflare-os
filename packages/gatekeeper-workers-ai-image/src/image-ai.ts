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

@validateRpc()
class ImageSessionImpl extends RpcTarget implements ImageSession {
  readonly #ai: Ai;

  constructor(ai: Ai) {
    super();
    this.#ai = ai;
  }

  async generateImage(
    prompt: string,
    options: GenerateImageOptions = {},
  ): Promise<GeneratedImage> {
    const model = options.model ?? DEFAULT_MODEL;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.#ai as any).run(model, {
      prompt,
      // flux-1-schnell uses num_steps; stable-diffusion uses steps. Pass both.
      ...(options.steps !== undefined ? { num_steps: options.steps, steps: options.steps } : {}),
    });

    // Most text-to-image models (including flux-1-schnell) return { image: string }
    // where image is already base64-encoded PNG. Stable-diffusion returns a ReadableStream.
    let base64: string;
    if (result && typeof (result as any).image === "string") {
      base64 = (result as any).image;
    } else {
      const arrayBuffer = await new Response(result as ReadableStream).arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      base64 = btoa(binary);
    }

    return { data: base64, mimeType: "image/png", prompt };
  }


}

// ---------------------------------------------------------------------------
// Gatekeeper (Durable Object) — one facet per workspace, holds the AI binding
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
    return new ImageSessionImpl(this.env.WORKERS_AI);
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
// Account (WorkerEntrypoint) — auto-provisioned per user, declares singleton
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
      // Declares the singleton so the Workshop folds ImageSession into every workspace.
      singleton: { tsType: "ImageSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ImageSession>>> {
    return this.ctx.exports.ImageGatekeeper({ props: this.ctx.props });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("AI Image Generation has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("AI Image Generation has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("AI Image Generation is auto-provisioned and has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ImageVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }
}

// ---------------------------------------------------------------------------
// Verifier — trivial; image output is not user-specific data
// ---------------------------------------------------------------------------

@validateRpc()
export class ImageVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{}

// ---------------------------------------------------------------------------
// Vendor (WorkerEntrypoint) — top-level entry, autoProvisionsAccount: true
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
        "Build gadgets that create illustrations, diagrams, and visuals on demand. " +
        "No external API keys required — uses your account's Workers AI allocation.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
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
    throw new Error("AI Image Generation is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

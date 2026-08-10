import type { RpcTarget } from "cloudflare:workers";

/** Options for generating an image. */
export interface GenerateImageOptions {
  /**
   * Workers AI text-to-image model.
   * Defaults to "@cf/black-forest-labs/flux-1-schnell".
   * Other option: "@cf/stabilityai/stable-diffusion-xl-base-1.0"
   */
  model?: string;
  /**
   * Number of inference steps. Higher = better quality, slower.
   * Omit to use the model's default (4 for flux-1-schnell).
   */
  steps?: number;
}

/** A generated image returned by the session. */
export interface GeneratedImage {
  /** Base64-encoded PNG image data. */
  data: string;
  /** MIME type — always "image/png". */
  mimeType: "image/png";
  /** The exact prompt used to generate this image. */
  prompt: string;
}

/** Session for generating images via Workers AI. */
export interface ImageSession extends RpcTarget {
  /**
   * Generate an image from a text prompt.
   * @param prompt Description of the image to generate.
   * @param options Optional model and inference settings.
   */
  generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage>;
}

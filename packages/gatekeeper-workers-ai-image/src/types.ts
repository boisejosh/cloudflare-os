import type { RpcTarget } from "cloudflare:workers";

export interface GenerateImageOptions {
  model?: string;
  steps?: number;
}

export interface GeneratedImage {
  data: string;
  mimeType: "image/png";
  prompt: string;
}

export interface ImageSession extends RpcTarget {
  generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage>;
  generateImageUrl(prompt: string, options?: GenerateImageOptions): Promise<string>;
}

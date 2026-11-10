import { type ComfyWorkflow } from "./ai";

/*
 * ComfyUI graphs and image sizes, shared by the server (connections it
 * calls) and the browser (connections on the person's own computer).
 */

/** Width/height for diffusion models: multiples of 16, about one megapixel or as asked, at most 2048. */
export function diffusionSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const area = Math.sqrt((1024 * 1024) / (width * height));
  // Never larger than asked, never past ~1 MP or 2048 px on a side.
  const factor = Math.min(scale, area);
  const snap = (value: number) => Math.max(256, Math.round((value * factor) / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

function fillPlaceholders(node: unknown, values: Record<string, string | number>): unknown {
  if (typeof node === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(node);
    if (whole?.[1] && whole[1] in values) {
      return values[whole[1]];
    }
    return node.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
  }
  if (Array.isArray(node)) {
    return node.map((item) => fillPlaceholders(item, values));
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fillPlaceholders(value, values)]));
  }
  return node;
}

export function comfyGraph(workflow: ComfyWorkflow, prompt: string, width: number, height: number, seed: number): Record<string, unknown> {
  if (workflow.preset === "custom") {
    return fillPlaceholders(JSON.parse(workflow.workflow), { prompt, width, height, seed }) as Record<string, unknown>;
  }
  if (workflow.preset === "flux3-klein") {
    // BFL's text-to-image graph without the optional prompt upsampler: shift log(16), cfg 1, euler.
    const shift = Math.log(16);
    return {
      1: { class_type: "UNETLoader", inputs: { unet_name: workflow.unet, weight_dtype: "default" } },
      2: { class_type: "CLIPLoader", inputs: { clip_name: workflow.textEncoder, type: "flux3", device: "default" } },
      3: { class_type: "VAELoader", inputs: { vae_name: workflow.vae } },
      4: { class_type: "ModelSamplingFlux", inputs: { model: ["1", 0], max_shift: shift, base_shift: shift, width, height } },
      5: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
      6: { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
      7: { class_type: "EmptyFlux2LatentImage", inputs: { width, height, batch_size: 1 } },
      8: { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed, steps: workflow.steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
      9: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      10: { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "mycanvas" } },
    };
  }
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: workflow.unet, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: workflow.textEncoder, type: "flux2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: workflow.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    5: { class_type: "EmptyFlux2LatentImage", inputs: { width, height, batch_size: 1 } },
    6: { class_type: "Flux2Scheduler", inputs: { steps: workflow.steps, width, height } },
    7: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    8: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    9: { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["4", 0] } },
    10: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["8", 0], guider: ["9", 0], sampler: ["7", 0], sigmas: ["6", 0], latent_image: ["5", 0] } },
    11: { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
    12: { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: "mycanvas" } },
  };
}

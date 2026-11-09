import { describe, expect, it } from "vitest";
import { comfyGraph, diffusionSize } from "./comfy";

describe("diffusionSize", () => {
  it("keeps 1024 squares and snaps to multiples of 16", () => {
    expect(diffusionSize(1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(diffusionSize(1000, 700)).toEqual({ width: 1008, height: 704 });
  });

  it("scales large requests down to about one megapixel, keeping the shape", () => {
    const { width, height } = diffusionSize(4000, 3000);
    expect(width * height).toBeLessThanOrEqual(1024 * 1024 * 1.05);
    expect(width / height).toBeCloseTo(4 / 3, 1);
  });
});

describe("comfyGraph", () => {
  it("fills placeholders, keeping numbers as numbers", () => {
    const workflow = JSON.stringify({
      1: { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}, high detail" } },
      2: { class_type: "EmptyLatentImage", inputs: { width: "{{width}}", height: "{{height}}", seed: "{{seed}}" } },
    });
    const graph = comfyGraph({ preset: "custom", workflow }, "a cat", 512, 768, 7) as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["1"]?.inputs.text).toBe("a cat, high detail");
    expect(graph["2"]?.inputs).toEqual({ width: 512, height: 768, seed: 7 });
  });

  it("builds the FLUX.2 klein preset with the chosen files", () => {
    const graph = comfyGraph({ preset: "flux2-klein", unet: "u.safetensors", textEncoder: "t.safetensors", vae: "v.safetensors", steps: 4 }, "x", 1024, 1024, 1) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(graph["1"]?.inputs.unet_name).toBe("u.safetensors");
    expect(graph["6"]?.inputs.steps).toBe(4);
    expect(Object.values(graph).some((node) => node.class_type === "SaveImage")).toBe(true);
  });
});

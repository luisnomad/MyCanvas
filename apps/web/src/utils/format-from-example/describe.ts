import { type FormatAiInstructions } from "@mycanvas/shared";
import { aiText } from "../ai-client";
import { type AnalyzedPage } from "./analyze-pdf";
import { classifyExample } from "./classify-example";

/** A page image small enough for a vision model, as a data: URL. */
async function pageDataUrl(blob: Blob, maxSide = 1024): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Asks the text model to write the format's AI instructions from the
 * example: how to recognise each kind of block in plain text, and the look
 * of its illustrations. Uses the page image when the model can see.
 */
export async function describeExample(pages: AnalyzedPage[]): Promise<FormatAiInstructions> {
  const roles = classifyExample(pages);
  // Two examples of each kind help the model spot patterns (labels, numbering).
  const examples: string[] = [];
  for (const [kind, sample] of Object.entries(roles.samples)) {
    const sameLook = roles.content.flat().filter((block) =>
      block.font.use === sample.block.font.use && block.font.weight === sample.block.font.weight &&
      Math.abs(block.size - sample.block.size) < 0.6 && block.color === sample.block.color && Boolean(block.box) === Boolean(sample.block.box));
    for (const block of sameLook.slice(0, 2)) {
      examples.push(`${kind}: ${block.text.replace(/\n/g, " ").slice(0, 160)}`);
    }
  }
  const system = [
    "You study an example document so an assistant can format new content the same way.",
    "You get the kinds of blocks found in the example (title, lead, heading, body, callout) with sample texts, and maybe a picture of the page.",
    "Write two short instructions in English:",
    "1. contentRules: how to recognise each kind of block in plain text, based on visible patterns (labels like \"KEY POINT:\", numbering like \"1.\", questions, length). Only rules the samples support; 1 to 4 sentences.",
    "2. illustrationStyle: the visual style of the pictures in the page (medium, colours with hex codes when clear, composition, background), so new pictures match. If there's no picture, describe a style that fits the page's colours and mood. One or two sentences, no subject matter.",
    "Answer JSON only: {\"contentRules\": \"…\", \"illustrationStyle\": \"…\"}",
  ].join("\n");
  const prompt = `Blocks found in the example:\n${examples.join("\n")}`;
  const first = pages[0];
  let text: string;
  try {
    text = await aiText({ system, prompt, json: true, temperature: 0.3, images: first ? [await pageDataUrl(first.reference)] : [] });
  } catch {
    // The model may not take pictures: describe from the text alone.
    text = await aiText({ system, prompt, json: true, temperature: 0.3 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    parsed = match ? JSON.parse(match[0]) : {};
  }
  const value = parsed as { contentRules?: unknown; illustrationStyle?: unknown };
  return {
    contentRules: typeof value.contentRules === "string" ? value.contentRules.trim().slice(0, 4000) : "",
    illustrationStyle: typeof value.illustrationStyle === "string" ? value.illustrationStyle.trim().slice(0, 4000) : "",
  };
}

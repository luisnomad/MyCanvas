import { readdir } from "node:fs/promises";
import path from "node:path";

import { type AssetUsage, type Design } from "@mycanvas/shared";

import { STARTER_TEMPLATES } from "./starter-templates";
import { designsDir, readJsonFile, templatesDir } from "./storage";

/** Assets a design draws: image layers and filled frames. */
function assetsOf(design: Design): Set<string> {
  const used = new Set<string>();
  for (const layer of design.layers) {
    if (layer.type === "image") {
      used.add(layer.asset);
    } else if (layer.type === "frame" && layer.content) {
      used.add(layer.content.asset);
    }
  }
  return used;
}

async function readAll(dir: string): Promise<Design[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const designs = await Promise.all(
    files.filter((file) => file.endsWith(".json")).map((file) => readJsonFile<Design>(path.join(dir, file))),
  );
  return designs.filter((design): design is Design => design !== null);
}

/** asset file name → the designs and templates that use it. */
export async function assetUsageIndex(): Promise<Map<string, AssetUsage[]>> {
  const index = new Map<string, AssetUsage[]>();
  const add = (designs: Design[], kind: AssetUsage["kind"]) => {
    for (const design of designs) {
      for (const asset of assetsOf(design)) {
        const list = index.get(asset) ?? [];
        list.push({ id: design.id, name: design.name, kind });
        index.set(asset, list);
      }
    }
  };
  add(await readAll(designsDir), "design");
  add([...(await readAll(templatesDir)), ...STARTER_TEMPLATES], "template");
  return index;
}

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Baked JPEG previews of the starter templates (starter-thumbnails/<id>.jpg),
// rendered from the editor at a 400px long side. Re-bake after editing a
// starter's layout.
const dir = path.join(import.meta.dirname, "starter-thumbnails");

function loadThumbnails(): Record<string, string | undefined> {
  const thumbnails: Record<string, string | undefined> = {};
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return thumbnails; // Previews are optional; the gallery shows the size instead.
  }
  for (const file of files) {
    if (file.endsWith(".jpg")) {
      const data = readFileSync(path.join(dir, file)).toString("base64");
      thumbnails[path.basename(file, ".jpg")] = `data:image/jpeg;base64,${data}`;
    }
  }
  return thumbnails;
}

export const STARTER_THUMBNAILS = loadThumbnails();

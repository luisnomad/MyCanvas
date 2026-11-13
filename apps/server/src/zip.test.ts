import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { storedZip } from "./zip";

describe("storedZip", () => {
  it("writes a zip that a standard reader opens, names and bytes intact", async () => {
    const files = [
      { name: "página-1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
      { name: "page-2.png", data: Buffer.alloc(5000, 7) },
    ];
    const zip = await JSZip.loadAsync(storedZip(files));
    expect(Object.keys(zip.files).sort()).toEqual(["page-2.png", "página-1.png"]);
    for (const file of files) {
      const entry = zip.file(file.name);
      expect(entry).not.toBeNull();
      expect(Buffer.from(await (entry!).async("uint8array")).equals(file.data)).toBe(true);
    }
  });
});

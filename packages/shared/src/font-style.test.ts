import { describe, expect, it } from "vitest";
import { formatFontStyle, parseFontStyle } from "./font-style";

describe("font style strings", () => {
  it("reads classic and numeric styles", () => {
    expect(parseFontStyle("normal")).toEqual({ weight: 400, italic: false });
    expect(parseFontStyle("bold")).toEqual({ weight: 700, italic: false });
    expect(parseFontStyle("italic bold")).toEqual({ weight: 700, italic: true });
    expect(parseFontStyle("bold italic")).toEqual({ weight: 700, italic: true });
    expect(parseFontStyle("300")).toEqual({ weight: 300, italic: false });
    expect(parseFontStyle("italic 900")).toEqual({ weight: 900, italic: true });
  });

  it("writes canonical strings Konva and CSS both accept", () => {
    expect(formatFontStyle({ weight: 400, italic: false })).toBe("normal");
    expect(formatFontStyle({ weight: 700, italic: false })).toBe("bold");
    expect(formatFontStyle({ weight: 700, italic: true })).toBe("italic bold");
    expect(formatFontStyle({ weight: 300, italic: true })).toBe("italic 300");
    expect(formatFontStyle({ weight: 950, italic: false })).toBe("900");
  });

  it("round-trips every weight", () => {
    for (let weight = 100; weight <= 900; weight += 100) {
      for (const italic of [false, true]) {
        expect(parseFontStyle(formatFontStyle({ weight, italic }))).toEqual({ weight, italic });
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { parsePdfFontName, resolvePdfFont } from "./font-names";

describe("PDF font names", () => {
  it("reads family, weight and italic", () => {
    expect(parsePdfFontName("ABCDEF+Montserrat-Black")).toEqual({ family: "Montserrat", weight: 900, italic: false });
    expect(parsePdfFontName("OpenSans-SemiBoldItalic")).toEqual({ family: "Open Sans", weight: 600, italic: true });
    expect(parsePdfFontName("RobotoCondensed-Light")).toEqual({ family: "Roboto Condensed", weight: 300, italic: false });
    expect(parsePdfFontName("Arial,Bold")).toEqual({ family: "Arial", weight: 700, italic: false });
    expect(parsePdfFontName("ArialMT")).toEqual({ family: "Arial", weight: 400, italic: false });
    expect(parsePdfFontName("Montserrat-ExtraBold")).toEqual({ family: "Montserrat", weight: 800, italic: false });
    expect(parsePdfFontName("PoppinsBold")).toEqual({ family: "Poppins", weight: 700, italic: false });
  });

  it("uses the Google font when we have it, else a stand-in", () => {
    expect(resolvePdfFont("XYZABC+OpenSans-Bold")).toMatchObject({ use: "Open Sans", exact: true, weight: 700 });
    expect(resolvePdfFont("Helvetica-Bold")).toMatchObject({ use: "Inter", exact: false, weight: 700 });
    expect(resolvePdfFont("MyriadPro-Regular")).toMatchObject({ use: "Open Sans", exact: false });
    expect(resolvePdfFont("TimesNewRomanPSMT")).toMatchObject({ use: "Libre Baskerville", exact: false });
  });
});

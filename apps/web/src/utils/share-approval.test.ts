import { describe, expect, it } from "vitest";
import { noticeStillValid } from "./share-approval";

describe("share page action notice", () => {
  const downloaded = { text: "PDF descargado. Puedes volver a descargarlo cuando quieras.", revision: 4 };

  it("stays while the same revision can still be downloaded", () => {
    expect(noticeStillValid(downloaded, { revision: 4, downloadable: true })).toBe(true);
  });

  it("goes when a new revision arrives", () => {
    expect(noticeStillValid(downloaded, { revision: 5, downloadable: false })).toBe(false);
    expect(noticeStillValid(downloaded, { revision: 5, downloadable: true })).toBe(false);
  });

  it("goes when the download is no longer allowed (e.g. changes were requested)", () => {
    expect(noticeStillValid(downloaded, { revision: 4, downloadable: false })).toBe(false);
  });

  it("shows nothing without a notice", () => {
    expect(noticeStillValid(null, { revision: 4, downloadable: true })).toBe(false);
  });
});

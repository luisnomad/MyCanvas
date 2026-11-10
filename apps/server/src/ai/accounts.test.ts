import { describe, expect, it } from "vitest";
import { nearestRatio, pickImageUrl, taskState } from "./accounts";

describe("account task answers", () => {
  it("prefers the picture without a watermark and skips covers", () => {
    const answer = { result: { images: [{ cover: "https://cdn.example/cover.jpg", url: "https://cdn.example/marked.png", urlWithoutWatermark: "https://cdn.example/clean.png" }] } };
    expect(pickImageUrl(answer)).toBe("https://cdn.example/clean.png");
  });

  it("finds an address inside plain text", () => {
    expect(pickImageUrl("Task SUCCEEDED. Output: https://dnznrvs05pmza.cloudfront.net/abc.png?_jwt=x.y.z")).toBe("https://dnznrvs05pmza.cloudfront.net/abc.png?_jwt=x.y.z");
  });

  it("reads running, finished and failed tasks", () => {
    expect(taskState({ status: "processing" }, "Kling").state).toBe("running");
    expect(taskState({ status: "succeed", works: [{ url: "https://a/b.png" }] }, "Kling")).toEqual({ state: "done", url: "https://a/b.png" });
    expect(taskState({ status: "SUCCEEDED", artifacts: [{ url: "https://a/c.webp" }] }, "Runway")).toEqual({ state: "done", url: "https://a/c.webp" });
    const failed = taskState({ status: "FAILED", failure: "No credits" }, "Runway");
    expect(failed).toEqual({ state: "error", message: "Runway couldn't make the picture: No credits." });
  });

  it("doesn't take a finished picture while the task still runs", () => {
    expect(taskState({ status: "RUNNING", promptImage: "https://a/ref.png" }, "Runway").state).toBe("running");
  });

  it("picks the nearest supported ratio", () => {
    expect(nearestRatio(1024, 640, ["1:1", "16:9", "4:3", "3:2"])).toBe("3:2");
    expect(nearestRatio(468, 1024, ["9:16", "3:4", "1:1"])).toBe("9:16");
  });
});

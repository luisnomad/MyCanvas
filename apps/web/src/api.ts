import { type AssetInfo, type Design, type DesignSummary, type TemplateSummary } from "@mycanvas/shared";

export class ApiError extends Error {
  status: number;
  /** Parsed JSON error body, when the server sent one. */
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = res.statusText;
    let body: unknown;
    try {
      body = await res.json();
      const error = (body as { error?: string }).error;
      if (error) {
        message = error;
      }
    } catch {
      // Response had no JSON body; keep the status text.
    }
    throw new ApiError(res.status, message, body);
  }
  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export type { AssetInfo };

export interface CreateDesignInput {
  name?: string;
  aspectRatioId?: string;
  width?: number;
  height?: number;
  background?: string;
  /** Start from this template (built-in or saved); size/background come from it. */
  templateId?: string;
}

export const api = {
  listDesigns: () => request<DesignSummary[]>("/api/designs"),
  createDesign: (input: CreateDesignInput) => request<Design>("/api/designs", jsonInit("POST", input)),
  getDesign: (id: string) => request<Design>(`/api/designs/${encodeURIComponent(id)}`),
  updateDesign: (id: string, design: Design) =>
    request<Design>(`/api/designs/${encodeURIComponent(id)}`, jsonInit("PUT", design)),
  deleteDesign: (id: string) =>
    request<{ ok: boolean }>(`/api/designs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  duplicateDesign: (id: string) =>
    request<Design>(`/api/designs/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
  listTemplates: () => request<TemplateSummary[]>("/api/templates"),
  saveTemplate: (designId: string, name?: string, thumbnail?: string) =>
    request<TemplateSummary>("/api/templates", jsonInit("POST", { designId, name, thumbnail })),
  deleteTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAssets: () => request<AssetInfo[]>("/api/assets"),
  uploadAsset: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Pick<AssetInfo, "asset" | "name">>("/api/assets", { method: "POST", body: form });
  },
  renameAsset: (file: string, name: string) =>
    request<Pick<AssetInfo, "asset" | "name">>(`/api/assets/${encodeURIComponent(file)}`, jsonInit("PATCH", { name })),
  /** Rejects with ApiError 409 (body.usedIn) for images in use unless `force`. */
  deleteAsset: (file: string, force = false) =>
    request<{ ok: boolean }>(`/api/assets/${encodeURIComponent(file)}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  systemFonts: () => request<string[]>("/api/fonts/system"),
  getFontFavorites: () => request<{ googleFontFavorites: string[] }>("/api/fonts/favorites"),
  setFontFavorites: (favorites: string[]) =>
    request<{ googleFontFavorites: string[] }>("/api/fonts/favorites", jsonInit("PUT", { googleFontFavorites: favorites })),
};

import {
  type AiCredits,
  type AiLoginStart,
  type AiLoginStatus,
  type AiImageJob,
  type AiImageRequest,
  type AiModelInfo,
  type AiSettings,
  type AiSettingsInput,
  type AssetInfo,
  type BlockDesign,
  type Design,
  type DesignLock,
  type DesignPage,
  type DesignSummary,
  type DocumentSource,
  type Folder,
  type TemplateSummary,
} from "@mycanvas/shared";

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

/**
 * This tab's id, sent with every request so live updates can tell this
 * tab's own changes from changes made elsewhere.
 */
export const CLIENT_ID = Math.random().toString(36).slice(2, 12);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-MyCanvas-Client", CLIENT_ID);
  const res = await fetch(url, { ...init, headers });
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

/** A design's share link (server: share-routes.ts). */
export interface ShareInfo {
  token: string;
  /** "/s/<token>" */
  path: string;
  hasPin: boolean;
  createdAt: string;
  /** When the link stops working, or null for never. */
  expiresAt: string | null;
  expired: boolean;
  /** When a viewer last opened it (to the minute), or null. */
  lastViewedAt: string | null;
}

export interface ShareState {
  share: ShareInfo | null;
  /** The public host for links (MYCANVAS_PUBLIC_URL), when the server knows it. */
  publicUrl?: string | null;
}

export interface CreateDesignInput {
  name?: string;
  aspectRatioId?: string;
  width?: number;
  height?: number;
  background?: string;
  /** Start from this template (built-in or saved); size/background come from it. */
  templateId?: string;
  /** File the new design in this folder. */
  folderId?: string;
  /** Ready-made pages (a document generated from a format). */
  pages?: DesignPage[];
  source?: DocumentSource;
  /** Designs made of visual blocks. */
  blocks?: BlockDesign;
}

/**
 * An editor save; `kind: null` turns a format back into a plain design.
 * `baseRevision` is the revision the edit started from: the server refuses
 * the save (409) when the stored design is newer.
 */
export type DesignUpdate = Omit<Design, "kind"> & { kind: "format" | null; baseRevision?: number };

export type { DesignLock };

export interface Me {
  email: string;
  via: "access" | "local";
  /** Ends the Cloudflare Access session; null for the local (LAN) route. */
  logoutUrl: string | null;
  /** The installation's owner (admin settings). */
  isOwner?: boolean;
}

export interface AdminAiSettings {
  /** Accounts allowed to use AI tools on the server's local network. */
  aiLocalNetwork: string[];
  /** Accounts that can sign in (to choose from). */
  accounts: string[];
}

export const api = {
  me: () => request<Me>("/api/me"),
  listDesigns: () => request<DesignSummary[]>("/api/designs"),
  createDesign: (input: CreateDesignInput) => request<Design>("/api/designs", jsonInit("POST", input)),
  getDesign: (id: string) => request<Design>(`/api/designs/${encodeURIComponent(id)}`),
  updateDesign: (id: string, design: DesignUpdate) =>
    request<Design>(`/api/designs/${encodeURIComponent(id)}`, jsonInit("PUT", design)),
  deleteDesign: (id: string) =>
    request<{ ok: boolean }>(`/api/designs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  duplicateDesign: (id: string) =>
    request<Design>(`/api/designs/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
  /** null unfiles the design. */
  moveDesign: (id: string, folderId: string | null) =>
    request<DesignSummary>(`/api/designs/${encodeURIComponent(id)}/move`, jsonInit("POST", { folderId })),
  /** Every locked design (lock badges in the project list). */
  getShare: (id: string) => request<ShareState>(`/api/designs/${encodeURIComponent(id)}/share`),
  /** Creates or changes the link: `pin` null removes it; `newLink` throws the old one away. */
  saveShare: (id: string, change: { pin?: string | null; newLink?: boolean; expiresInDays?: number | null }) =>
    request<ShareState>(`/api/designs/${encodeURIComponent(id)}/share`, jsonInit("PUT", change)),
  stopShare: (id: string) => request<ShareState>(`/api/designs/${encodeURIComponent(id)}/share`, { method: "DELETE" }),
  listLocks: () => request<DesignLock[]>("/api/locks"),
  getLock: (id: string) => request<DesignLock | null>(`/api/designs/${encodeURIComponent(id)}/lock`),
  /** Locks the design to this person (first edit); ApiError 423 while Claude has it. */
  lockDesign: (id: string) => request<DesignLock>(`/api/designs/${encodeURIComponent(id)}/lock`, { method: "POST" }),
  /** Takes the design back from Claude at once. */
  takeOverDesign: (id: string) => request<DesignLock>(`/api/designs/${encodeURIComponent(id)}/lock/takeover`, { method: "POST" }),
  unlockDesign: (id: string) =>
    request<{ ok: boolean; released: boolean }>(`/api/designs/${encodeURIComponent(id)}/lock`, { method: "DELETE" }),
  listFolders: () => request<Folder[]>("/api/folders"),
  createFolder: (name: string) => request<Folder>("/api/folders", jsonInit("POST", { name })),
  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${encodeURIComponent(id)}`, jsonInit("PATCH", { name })),
  /** Its designs are kept and become unfiled. */
  deleteFolder: (id: string) =>
    request<{ ok: boolean; unfiled: number }>(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listTemplates: () => request<TemplateSummary[]>("/api/templates"),
  saveTemplate: (designId: string, name?: string, thumbnail?: string) =>
    request<TemplateSummary>("/api/templates", jsonInit("POST", { designId, name, thumbnail })),
  deleteTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAssets: () => request<AssetInfo[]>("/api/assets"),
  /** With `folderId`, the upload is filed in that upload folder. */
  uploadAsset: (file: File, folderId?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (folderId) {
      form.append("folderId", folderId);
    }
    return request<Pick<AssetInfo, "asset" | "name">>("/api/assets", { method: "POST", body: form });
  },
  /** Upload folders: separate from design folders. */
  listAssetFolders: () => request<Folder[]>("/api/asset-folders"),
  createAssetFolder: (name: string) => request<Folder>("/api/asset-folders", jsonInit("POST", { name })),
  renameAssetFolder: (id: string, name: string) =>
    request<Folder>(`/api/asset-folders/${encodeURIComponent(id)}`, jsonInit("PATCH", { name })),
  /** Its uploads are kept and become unfiled. */
  deleteAssetFolder: (id: string) => request<{ ok: boolean }>(`/api/asset-folders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Files uploads in a folder; null takes them out of any folder. */
  moveAssets: (assets: string[], folderId: string | null) =>
    request<{ ok: boolean; moved: number }>("/api/assets/move", jsonInit("POST", { assets, folderId })),
  renameAsset: (file: string, name: string) =>
    request<Pick<AssetInfo, "asset" | "name">>(`/api/assets/${encodeURIComponent(file)}`, jsonInit("PATCH", { name })),
  /** Rejects with ApiError 409 (body.usedIn) for images in use unless `force`. */
  deleteAsset: (file: string, force = false) =>
    request<{ ok: boolean }>(`/api/assets/${encodeURIComponent(file)}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  aiSettings: () => request<AiSettings>("/api/ai/settings"),
  saveAiSettings: (input: AiSettingsInput) => request<AiSettings>("/api/ai/settings", jsonInit("PUT", input)),
  /** Also tests the connection: rejects with the provider's message when it can't connect. */
  aiModels: (connectionId: string) => request<{ models: AiModelInfo[] }>("/api/ai/models", jsonInit("POST", { connectionId })),
  adminAi: () => request<AdminAiSettings>("/api/admin/ai"),
  saveAdminAi: (aiLocalNetwork: string[]) => request<Pick<AdminAiSettings, "aiLocalNetwork">>("/api/admin/ai", jsonInit("PUT", { aiLocalNetwork })),
  aiStatus: () => request<{ text: boolean; image: boolean }>("/api/ai/status"),
  aiText: (input: { system: string; prompt: string; json?: boolean; temperature?: number; images?: string[] }) =>
    request<{ text: string; model: string; connection: string }>("/api/ai/text", jsonInit("POST", input)),
  startAiImage: (input: AiImageRequest) => request<AiImageJob>("/api/ai/image", jsonInit("POST", input)),
  aiJob: (id: string) => request<AiImageJob>(`/api/ai/jobs/${encodeURIComponent(id)}`),
  /** A finished picture started with `keep: false`. */
  aiJobImage: async (id: string) => {
    const res = await fetch(`/api/ai/jobs/${encodeURIComponent(id)}/image`);
    if (!res.ok) {
      throw new ApiError(res.status, res.status === 404 ? "The picture is no longer available. Make it again." : res.statusText);
    }
    return res.blob();
  },
  /** Account connections: start a login (open `url`), then poll its state. */
  aiLogin: (connectionId: string) => request<AiLoginStart>("/api/ai/login", jsonInit("POST", { connectionId })),
  aiLoginStatus: (id: string) => request<AiLoginStatus>(`/api/ai/login/${encodeURIComponent(id)}`),
  aiCredits: (connectionId: string) => request<AiCredits>("/api/ai/credits", jsonInit("POST", { connectionId })),
  systemFonts: () => request<string[]>("/api/fonts/system"),
  getFontFavorites: () => request<{ googleFontFavorites: string[] }>("/api/fonts/favorites"),
  setFontFavorites: (favorites: string[]) =>
    request<{ googleFontFavorites: string[] }>("/api/fonts/favorites", jsonInit("PUT", { googleFontFavorites: favorites })),
};

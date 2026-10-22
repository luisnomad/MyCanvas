import { useCallback, useEffect, useState } from "react";
import { type AssetInfo, type AssetUsage } from "@mycanvas/shared";
import { api } from "../../api";
import { getCachedImageSize } from "../../hooks/useImage";
import { useEditorStore } from "../../store/editorStore";

export type AssetFilter = "all" | "used" | "unused" | "generated";

export const ASSET_FILTERS: { id: AssetFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "used", label: "In use" },
  { id: "unused", label: "Unused" },
  { id: "generated", label: "AI results" },
];

export const UPLOAD_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

/**
 * Where an asset is used, including the design open in the editor (its
 * latest edits may not be saved yet, so the server can't know about them).
 */
export function usageOf(info: AssetInfo): AssetUsage[] {
  const design = useEditorStore.getState().design;
  if (!design || info.usedIn.some((use) => use.kind === "design" && use.id === design.id)) {
    return info.usedIn;
  }
  const usesIt = design.layers.some((layer) =>
    (layer.type === "image" && layer.asset === info.asset) ||
    (layer.type === "frame" && layer.content?.asset === info.asset));
  return usesIt ? [{ id: design.id, name: design.name, kind: "design" }, ...info.usedIn] : info.usedIn;
}

export function filterAssets(assets: AssetInfo[], filter: AssetFilter, query: string): AssetInfo[] {
  const needle = query.trim().toLowerCase();
  return assets.filter((info) => {
    if (needle && !info.name.toLowerCase().includes(needle)) {
      return false;
    }
    switch (filter) {
      case "all":
        return true;
      case "used":
        return usageOf(info).length > 0;
      case "unused":
        return usageOf(info).length === 0;
      case "generated":
        return info.generated;
    }
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Natural pixel size of an uploaded image (cached after the first load). */
export function loadAssetSize(asset: string): Promise<{ width: number; height: number }> {
  const url = `/assets/${asset}`;
  const cached = getCachedImageSize(url);
  if (cached) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    };
    img.onerror = () => {
      reject(new Error("Image failed to load"));
    };
    img.src = url;
  });
}

/** The shared library; refetches whenever anything bumps assetsVersion. */
export function useAssetLibrary() {
  const assetsVersion = useEditorStore((state) => state.assetsVersion);
  const bumpAssetsVersion = useEditorStore((state) => state.bumpAssetsVersion);
  const [assets, setAssets] = useState<AssetInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAssets()
      .then((list) => {
        if (!cancelled) {
          setAssets(list);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not load uploads");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [assetsVersion]);

  /** Uploads files one by one; returns the new assets (failures reported). */
  const upload = useCallback(async (files: File[]) => {
    const added: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        added.push((await api.uploadAsset(file)).asset);
      } catch (reason) {
        failures.push(`${file.name}: ${reason instanceof Error ? reason.message : "upload failed"}`);
      }
    }
    if (added.length > 0) {
      bumpAssetsVersion();
    }
    setError(failures.length > 0 ? failures.join(" · ") : null);
    return added;
  }, [bumpAssetsVersion]);

  const rename = useCallback(async (asset: string, name: string) => {
    await api.renameAsset(asset, name);
    bumpAssetsVersion();
  }, [bumpAssetsVersion]);

  /** Force-deletes (the caller has already confirmed any in-use images). */
  const remove = useCallback(async (assetIds: string[]) => {
    for (const asset of assetIds) {
      await api.deleteAsset(asset, true);
    }
    bumpAssetsVersion();
  }, [bumpAssetsVersion]);

  return { assets, error, setError, upload, rename, remove };
}

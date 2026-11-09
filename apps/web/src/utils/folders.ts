/** Which designs the project list shows; lives in the URL hash. */
export type FolderView = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; id: string };

export const ALL_DESIGNS: FolderView = { kind: "all" };

export function folderViewFromHash(hash: string): FolderView | null {
  const match = /^#\/folder\/([^/?#]+)$/.exec(hash);
  if (!match?.[1]) {
    return null;
  }
  const id = decodeURIComponent(match[1]);
  return id === "unfiled" ? { kind: "unfiled" } : { kind: "folder", id };
}

export function folderViewHash(view: FolderView): string {
  switch (view.kind) {
    case "all":
      return "#/";
    case "unfiled":
      return "#/folder/unfiled";
    case "folder":
      return `#/folder/${encodeURIComponent(view.id)}`;
  }
}

export function inView(view: FolderView, folderId: string | undefined): boolean {
  switch (view.kind) {
    case "all":
      return true;
    case "unfiled":
      return folderId === undefined;
    case "folder":
      return folderId === view.id;
  }
}

/** Drag payload for moving a design card onto a folder. */
export const DESIGN_DRAG_MIME = "application/x-mycanvas-design";

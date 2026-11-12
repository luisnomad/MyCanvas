import {
  type BlockDesign,
  type Design,
  type DesignLock,
  type DesignPage,
  type DocumentSource,
  type FormatAiInstructions,
  type FrameLayer,
  type GradientFill,
  type ImageLayer,
  type Layer,
  type LineLayer,
  type RectLayer,
  type PageContent,
  type TextLayer,
  defaultShadow,
  frameContentBox,
  normalizeDesign,
  recoverContent,
} from "@mycanvas/shared";
import { create } from "zustand";
import { ApiError, type DesignUpdate, api } from "../api";
import { makeDesignThumbnail } from "../utils/canvas-bridge";
import { ensureFontsLoaded } from "../utils/fonts";
import { getCachedImageSize } from "../hooks/useImage";

export type SaveStatus = "saved" | "saving" | "dirty";
export type LoadStatus = "loading" | "ready" | "not-found" | "error";

/**
 * The design being edited. Its top-level `layers`/`background` are the
 * ACTIVE page, live — so everything that edits "the canvas" keeps working.
 * `pages` holds every page; the active entry is refreshed from the live
 * fields whenever pages are read as a whole (see syncedPages).
 */
export type EditorDesign = Design & PageContent;

/** History entry: every page plus which one was open. */
interface Snapshot {
  pages: DesignPage[];
  activePageId: string;
  /** Designs made of blocks: which block each page shows (undone with the pages). */
  blocks?: BlockDesign;
}

/**
 * All pages with the active one brought up to date from the live fields.
 * `thumbnail` (when given) refreshes the active page's preview, e.g. the
 * canvas as it looks right before switching away from it.
 */
export function syncedPages(design: EditorDesign, activePageId: string, thumbnail?: string | null): DesignPage[] {
  return design.pages.map((page) =>
    page.id === activePageId
      ? {
          ...page,
          layers: design.layers,
          background: design.background,
          backgroundGradient: design.backgroundGradient,
          thumbnail: thumbnail ?? page.thumbnail,
        }
      : page);
}

/** Opens `pageId` in the editor: its content becomes the live fields. */
function withActivePage(design: Design, pageId: string): EditorDesign {
  const page = design.pages.find((entry) => entry.id === pageId) ?? design.pages[0];
  return {
    ...design,
    layers: page?.layers ?? [],
    background: page?.background ?? "#ffffff",
    backgroundGradient: page?.backgroundGradient,
  };
}

/** Every layer on every page, live (upload usage, fonts, colors). */
export function allDesignLayers(design: EditorDesign, activePageId: string): Layer[] {
  return syncedPages(design, activePageId).flatMap((page) => page.layers);
}

/** Any subset of layer-specific fields; only the keys matching the layer type are applied in practice. */
export type LayerPatch = Partial<TextLayer>
  & Partial<ImageLayer>
  & Partial<RectLayer>
  & Partial<LineLayer>
  & Partial<FrameLayer>;

/** Text appearance, excluding the destination's content and geometry. */
type TextStyle = Pick<TextLayer,
  "fontFamily" | "fontSize" | "fontStyle" | "fill" | "align"
  | "lineHeight" | "letterSpacing" | "wrapWidth" | "curve" | "effect"
  | "shadow" | "stroke" | "opacity">;

const HISTORY_LIMIT = 100;

/**
 * Applies a patch to a layer. A frame whose photo box changes (resize, or a
 * rotation while the photo keeps its angle) gets its photo re-covered, unless
 * the patch places the photo itself.
 */
function patchLayer(layer: Layer, patch: LayerPatch): Layer {
  const next = { ...layer, ...patch } as Layer;
  if (layer.type !== "frame" || next.type !== "frame" || !layer.content || !next.content || "content" in patch) {
    return next;
  }
  const before = frameContentBox(layer);
  const after = frameContentBox(next);
  if (before.width === after.width && before.height === after.height) {
    return next;
  }
  const natural = getCachedImageSize(`/assets/${layer.content.asset}`);
  if (!natural) {
    return next;
  }
  return { ...next, content: recoverContent(layer.content, natural.width, natural.height, before.width, before.height, after.width, after.height) };
}
const AUTOSAVE_DELAY_MS = 800;

export interface EditorStore {
  design: EditorDesign | null;
  /** The page shown on the canvas. */
  activePageId: string;
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  /** Selection set in click order; the last entry is the "primary" layer. */
  selectedLayerIds: string[];
  /** Group currently entered for isolated member editing (double-click). */
  editingGroupId: string | null;
  past: Snapshot[];
  future: Snapshot[];
  pendingSnapshot: Snapshot | null;

  loadDesign: (id: string) => Promise<void>;
  unload: () => void;
  /** Unsaved changes made by this person (not just a pending preview refresh). */
  unsavedEdits: boolean;
  /** Who is editing the open design: null = nobody (anyone's first edit locks it). */
  lock: DesignLock | null;
  setLock: (lock: DesignLock | null) => void;
  /** Takes the design back from Claude. */
  takeOver: () => Promise<void>;
  /** Saves pending changes, then releases this person's lock. Resolves true when unlocked. */
  unlock: () => Promise<boolean>;
  /**
   * Brings in a newer version saved elsewhere (Claude or another tab):
   * keeps the open page and selection where they still exist, clears undo
   * history. `message` is shown as a toast.
   */
  syncFromServer: (message?: string) => Promise<void>;
  /** Replace the selection (group-aware: a member selects its whole group). */
  selectLayer: (id: string | null) => void;
  /** Shift-click toggle (group-aware). */
  toggleSelectLayer: (id: string) => void;
  setSelectedLayers: (ids: string[]) => void;
  setEditingGroup: (id: string | null) => void;
  setName: (name: string) => void;
  setBackground: (background: string, transient?: boolean) => void;
  /** Solid background when undefined. */
  setBackgroundGradient: (gradient: GradientFill | undefined, transient?: boolean) => void;
  addLayer: (layer: Layer) => void;
  /** Insert a layer at a z-index, select it, one history entry. */
  addLayerAt: (layer: Layer, index: number) => void;
  addImageLayer: (asset: string, naturalWidth: number, naturalHeight: number) => void;
  addImageLayerAt: (
    asset: string,
    naturalWidth: number,
    naturalHeight: number,
    centerX: number,
    centerY: number,
  ) => void;
  /** Cover-fit image layer inserted at the BOTTOM of the stack (drop-at-edge). */
  addImageLayerAsBackground: (asset: string, naturalWidth: number, naturalHeight: number) => void;
  /** Incremented whenever an asset is uploaded so the Uploads panel refetches. */
  assetsVersion: number;
  bumpAssetsVersion: () => void;
  /** Text layer currently being edited in place (textarea overlay). */
  editingTextLayerId: string | null;
  setEditingTextLayer: (id: string | null) => void;
  /** Frame layer whose content is being panned/zoomed (double-click mode). */
  editingFrameId: string | null;
  setEditingFrame: (id: string | null) => void;
  /** Open right-click menu (client coords + target layer). */
  contextMenu: { x: number; y: number; layerId: string } | null;
  openContextMenu: (menu: { x: number; y: number; layerId: string }) => void;
  closeContextMenu: () => void;
  /** Active worker job: download progress (0–1) or null = inference/composite. */
  bgRemoval: { layerId: string; progress: number | null; kind: "cutout" | "portrait" } | null;
  setBgRemoval: (value: { layerId: string; progress: number | null; kind: "cutout" | "portrait" } | null) => void;
  /** Minimal transient toast message. */
  toast: string | null;
  showToast: (message: string) => void;
  /** Extracted photo palettes, keyed by asset+crop (see utils/photo-colors). */
  photoPalettes: Record<string, string[]>;
  setPhotoPalette: (key: string, colors: string[]) => void;
  updateLayer: (id: string, patch: LayerPatch, transient?: boolean) => void;
  /** Multi-layer patch, one history entry (group drag/transform write-back). */
  updateLayers: (entries: { id: string; patch: LayerPatch }[]) => void;
  /** Lock the selection — or unlock it when every selected layer is locked. */
  toggleLockSelected: () => void;
  commitTransient: () => void;
  removeLayer: (id: string) => void;
  removeSelectedLayers: () => void;
  duplicateLayer: (id: string) => void;
  duplicateSelectedLayers: () => void;
  copyLayer: (id: string) => void;
  copySelectedLayers: () => void;
  pasteLayers: () => void;
  textStyleClipboard: TextStyle | null;
  copyTextStyle: (id: string) => void;
  pasteTextStyle: (id: string) => void;
  moveLayer: (id: string, direction: 1 | -1) => void;
  moveSelectedLayers: (direction: 1 | -1) => void;
  reorderLayerBlock: (sourceIds: string[], targetIds: string[], above: boolean) => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  undo: () => void;
  redo: () => void;
  saveNow: () => Promise<void>;
  /** Show another page (not an edit: no history entry). */
  setActivePage: (pageId: string) => void;
  /** New page after the active one (blank with the same background, or a copy), opened. */
  addPage: (options?: { duplicate?: boolean }) => void;
  /** Removes a page (never the last one) and opens its neighbor. */
  deletePage: (pageId: string) => void;
  /** Moves a page to a new position (0-based). */
  movePage: (pageId: string, toIndex: number) => void;
  /** Marks the design as a document format (or back to a plain design). */
  setDesignKind: (kind: "format" | undefined) => void;
  /** A format's instructions for the AI tools. */
  setFormatAi: (formatAi: FormatAiInstructions) => void;
  /** Patches layers wherever they are, on any page (one undo step). */
  updateLayersOnAnyPage: (entries: { id: string; patch: LayerPatch }[]) => void;
  /** Replaces every page (one undo step), e.g. after re-flowing content. */
  replacePages: (pages: DesignPage[], source?: DocumentSource) => void;
  /** Designs made of blocks: redrawn pages (matched by id) and the new block record, one undo step. */
  redrawBlocks: (pages: DesignPage[], blocks: BlockDesign) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight = false;
/** The server's headless renderer: it only reads and draws, never saves or locks. */
let headless = false;

export function setHeadlessMode(on: boolean): void {
  headless = on;
}
let saveAgain = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** In-app layer clipboard (z-order preserved; shared across designs). */
let layerClipboard: Layer[] = [];

export function newLayerId(): string {
  return crypto.randomUUID();
}

/** The primary layer of a selection set (last clicked), or null. */
export function primarySelectedId(state: { selectedLayerIds: string[] }): string | null {
  return state.selectedLayerIds[state.selectedLayerIds.length - 1] ?? null;
}

/**
 * Lock guard: a locked layer only accepts patches that change `locked` itself
 * (i.e. unlock). Everything else — geometry, style, name — is a no-op so no
 * UI path can bypass the freeze.
 */
function patchAllowedOnLocked(patch: LayerPatch): boolean {
  return Object.keys(patch).every((key) => key === "locked");
}

/** Sequential names: next free image_N across the design, case-insensitive. */
function nextImageName(layers: Layer[]): string {
  let maxIndex = 0;
  for (const existing of layers) {
    const match = /^image_(\d+)$/i.exec(existing.name);
    if (match?.[1]) {
      maxIndex = Math.max(maxIndex, Number(match[1]));
    }
  }
  return `image_${String(maxIndex + 1)}`;
}

/**
 * Migrates legacy per-field shadow/stroke toggles on text layers to the
 * mutually-exclusive effect model (one effect or none).
 */
function migrateTextEffect(layer: Layer): Layer {
  if (layer.type !== "text" || layer.effect) {
    return layer;
  }
  if (layer.shadow.enabled) {
    const distance = Math.round(Math.hypot(layer.shadow.offsetX, layer.shadow.offsetY));
    const angle = Math.round((Math.atan2(layer.shadow.offsetY, layer.shadow.offsetX) * 180) / Math.PI);
    return {
      ...layer,
      effect: {
        type: "shadow",
        color: layer.shadow.color,
        distance,
        angle,
        blur: layer.shadow.blur,
        opacity: layer.shadow.opacity,
      },
    };
  }
  if (layer.stroke.enabled) {
    return { ...layer, effect: { type: "outline", color: layer.stroke.color, thickness: layer.stroke.width } };
  }
  return { ...layer, effect: { type: "none" } };
}

/** A copy of a page's content with fresh layer and group ids. */
export function clonePageContent(page: PageContent): PageContent {
  const groupIds = new Map<string, string>();
  return {
    background: page.background,
    backgroundGradient: structuredClone(page.backgroundGradient),
    layers: page.layers.map((layer) => {
      const copy = structuredClone(layer);
      copy.id = newLayerId();
      if (copy.groupId) {
        const mapped = groupIds.get(copy.groupId) ?? newLayerId();
        groupIds.set(copy.groupId, mapped);
        copy.groupId = mapped;
      }
      return copy;
    }),
  };
}

export const useEditorStore = create<EditorStore>()((set, get) => {
  const snapshotOf = (design: EditorDesign): Snapshot => {
    const activePageId = get().activePageId;
    return { pages: structuredClone(syncedPages(design, activePageId)), activePageId, blocks: design.blocks ? structuredClone(design.blocks) : undefined };
  };

  /** Puts a history entry back: its pages, with its page open. */
  const restore = (design: EditorDesign, snapshot: Snapshot) => {
    set({
      design: withActivePage({ ...design, pages: snapshot.pages, blocks: "blocks" in snapshot ? snapshot.blocks : design.blocks }, snapshot.activePageId),
      activePageId: snapshot.activePageId,
      selectedLayerIds: [],
      editingGroupId: null,
      editingTextLayerId: null,
      editingFrameId: null,
    });
  };

  /**
   * Page-level edit (add/delete/move): one history entry, then the new page
   * list with `activePageId` open.
   */
  const changePages = (fn: (pages: DesignPage[], activePageId: string) => { pages: DesignPage[]; activePageId: string } | null) => {
    get().commitTransient();
    const design = get().design;
    if (!design) {
      return;
    }
    const result = fn(syncedPages(design, get().activePageId, makeDesignThumbnail()), get().activePageId);
    if (!result) {
      return;
    }
    pushHistory();
    restore(design, result);
    markDirty();
  };

  /**
   * Marks unsaved changes and schedules the autosave. A real edit (`edit`,
   * the default) also locks the design to this person on the first change;
   * housekeeping saves (a missing preview) never lock.
   */
  const markDirty = (edit = true) => {
    if (headless) {
      return;
    }
    if (edit && get().lock?.holder !== "human") {
      requestLock();
    }
    if (edit && !get().unsavedEdits) {
      set({ unsavedEdits: true });
    }
    if (get().saveStatus !== "dirty") {
      set({ saveStatus: "dirty" });
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      void get().saveNow();
    }, AUTOSAVE_DELAY_MS);
  };

  let lockRequest: Promise<void> | null = null;

  /** Locks the open design to this person (first edit). */
  const requestLock = () => {
    const design = get().design;
    if (!design || lockRequest) {
      return;
    }
    lockRequest = api.lockDesign(design.id)
      .then((lock) => {
        if (get().design?.id === design.id) {
          set({ lock });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 423 && get().design?.id === design.id) {
          const lock = (error.body as { lock?: DesignLock } | undefined)?.lock ?? null;
          set({ lock });
          get().showToast(`${lock?.label ?? "Claude"} is editing this design, so your change can't be saved.`);
        }
      })
      .finally(() => {
        lockRequest = null;
      });
  };

  const pushHistory = () => {
    const design = get().design;
    if (!design) {
      return;
    }
    set((state) => ({
      past: [...state.past.slice(-(HISTORY_LIMIT - 1)), snapshotOf(design)],
      future: [],
    }));
  };

  /**
   * Applies a mutation to layers and/or background. Discrete mutations push a
   * history entry immediately; transient ones (slider/color drags) capture a
   * pending snapshot on the first change, pushed by commitTransient().
   */
  const mutate = (fn: (design: EditorDesign) => Pick<PageContent, "layers"> | PageContent, transient: boolean) => {
    const design = get().design;
    if (!design) {
      return;
    }
    const result = fn(design);
    if (result.layers === design.layers && !("background" in result)) {
      return;
    }
    if (transient) {
      if (!get().pendingSnapshot) {
        set({ pendingSnapshot: snapshotOf(design) });
      }
    } else {
      pushHistory();
    }
    set({ design: { ...design, ...result } });
    markDirty();
  };

  return {
    design: null,
    activePageId: "",
    loadStatus: "loading",
    saveStatus: "saved",
    selectedLayerIds: [],
    editingGroupId: null,
    past: [],
    future: [],
    pendingSnapshot: null,
    textStyleClipboard: null,

    loadDesign: async (id) => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      set({
        design: null,
        loadStatus: "loading",
        saveStatus: "saved",
        selectedLayerIds: [],
        editingGroupId: null,
        past: [],
        future: [],
        pendingSnapshot: null,
        editingTextLayerId: null,
        editingFrameId: null,
        contextMenu: null,
        lock: null,
        unsavedEdits: false,
      });
      void api.getLock(id).then((lock) => {
        if (get().design?.id === id || get().loadStatus === "loading") {
          set({ lock });
        }
      }).catch(() => undefined);
      try {
        const design = normalizeDesign(await api.getDesign(id));
        design.pages = design.pages.map((page) => ({ ...page, layers: page.layers.map(migrateTextEffect) }));
        const firstPageId = design.pages[0]?.id ?? "";
        set({ design: withActivePage(design, firstPageId), activePageId: firstPageId, loadStatus: "ready" });
        const textLayers = design.pages
          .flatMap((page) => page.layers)
          .filter((layer): layer is TextLayer => layer.type === "text");
        void ensureFontsLoaded(textLayers).then(() => {
          // Designs made outside the editor (e.g. generated documents) have
          // no previews yet: once page 1 has had time to draw its images,
          // save it so the project list shows the cover.
          if (design.pages[0]?.thumbnail) {
            return;
          }
          setTimeout(() => {
            const state = get();
            // Not while Claude holds the lock: it couldn't be saved anyway.
            if (state.design?.id === id && state.activePageId === firstPageId && !state.design.pages[0]?.thumbnail && state.lock?.holder !== "agent") {
              markDirty(false);
            }
          }, 1500);
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          set({ loadStatus: "not-found" });
        } else {
          set({ loadStatus: "error" });
        }
      }
    },

    unload: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      set({
        design: null,
        loadStatus: "loading",
        saveStatus: "saved",
        selectedLayerIds: [],
        editingGroupId: null,
        past: [],
        future: [],
        pendingSnapshot: null,
        editingTextLayerId: null,
        editingFrameId: null,
        lock: null,
        unsavedEdits: false,
      });
    },

    lock: null,
    unsavedEdits: false,

    setLock: (lock) => {
      set({ lock });
    },

    takeOver: async () => {
      const design = get().design;
      if (!design) {
        return;
      }
      try {
        const lock = await api.takeOverDesign(design.id);
        set({ lock });
      } catch {
        get().showToast("Couldn't take the design over. Check the connection and try again.");
      }
    },

    unlock: async () => {
      const design = get().design;
      if (!design) {
        return false;
      }
      get().commitTransient();
      await get().saveNow();
      if (get().saveStatus !== "saved") {
        get().showToast("Your last changes aren't saved yet, so the design stays locked.");
        return false;
      }
      try {
        await api.unlockDesign(design.id);
        set({ lock: null });
        return true;
      } catch {
        get().showToast("Couldn't unlock the design. Check the connection and try again.");
        return false;
      }
    },

    syncFromServer: async (message) => {
      const current = get().design;
      if (!current) {
        return;
      }
      let fresh: Design;
      try {
        fresh = normalizeDesign(await api.getDesign(current.id));
      } catch {
        return;
      }
      const state = get();
      if (state.design?.id !== current.id) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      fresh.pages = fresh.pages.map((page) => ({ ...page, layers: page.layers.map(migrateTextEffect) }));
      const pageId = fresh.pages.some((page) => page.id === state.activePageId) ? state.activePageId : fresh.pages[0]?.id ?? "";
      const next = withActivePage(fresh, pageId);
      const ids = new Set(next.layers.map((layer) => layer.id));
      set({
        design: next,
        activePageId: pageId,
        saveStatus: "saved",
        unsavedEdits: false,
        selectedLayerIds: state.selectedLayerIds.filter((id) => ids.has(id)),
        editingGroupId: state.editingGroupId && next.layers.some((layer) => layer.groupId === state.editingGroupId) ? state.editingGroupId : null,
        editingTextLayerId: state.editingTextLayerId && ids.has(state.editingTextLayerId) ? state.editingTextLayerId : null,
        editingFrameId: state.editingFrameId && ids.has(state.editingFrameId) ? state.editingFrameId : null,
        contextMenu: null,
        // Undoing past someone else's changes would fight the lock.
        past: [],
        future: [],
        pendingSnapshot: null,
      });
      void ensureFontsLoaded(fresh.pages.flatMap((page) => page.layers).filter((layer): layer is TextLayer => layer.type === "text"));
      if (message) {
        get().showToast(message);
      }
    },

    selectLayer: (id) => {
      if (!id) {
        set({ selectedLayerIds: [], editingGroupId: null });
        return;
      }
      const design = get().design;
      const layer = design?.layers.find((entry) => entry.id === id);
      if (design && layer?.groupId) {
        if (layer.groupId === get().editingGroupId) {
          // Inside an entered group: select just the member.
          set({ selectedLayerIds: [id] });
          return;
        }
        // A member of a (non-entered) group selects the whole group.
        set({
          editingGroupId: null,
          selectedLayerIds: design.layers.filter((entry) => entry.groupId === layer.groupId).map((entry) => entry.id),
        });
        return;
      }
      set({ editingGroupId: null, selectedLayerIds: [id] });
    },

    toggleSelectLayer: (id) => {
      const design = get().design;
      const layer = design?.layers.find((entry) => entry.id === id);
      if (!design || !layer) {
        return;
      }
      const memberIds =
        layer.groupId && layer.groupId !== get().editingGroupId
          ? design.layers.filter((entry) => entry.groupId === layer.groupId).map((entry) => entry.id)
          : [id];
      const current = get().selectedLayerIds;
      const allSelected = memberIds.every((memberId) => current.includes(memberId));
      if (allSelected) {
        set({ selectedLayerIds: current.filter((memberId) => !memberIds.includes(memberId)) });
      } else {
        set({ selectedLayerIds: [...current.filter((memberId) => !memberIds.includes(memberId)), ...memberIds] });
      }
    },

    setSelectedLayers: (ids) => {
      set({ selectedLayerIds: ids });
    },

    setEditingGroup: (id) => {
      set({ editingGroupId: id });
    },

    setName: (name) => {
      const design = get().design;
      if (!design) {
        return;
      }
      set({ design: { ...design, name } });
      markDirty();
    },

    setBackground: (background, transient = false) => {
      mutate((design) => ({ layers: design.layers, background }), transient);
    },

    setBackgroundGradient: (backgroundGradient, transient = false) => {
      mutate((design) => ({ layers: design.layers, background: design.background, backgroundGradient }), transient);
    },

    addLayer: (layer) => {
      mutate((design) => ({ layers: [...design.layers, layer] }), false);
      set({ selectedLayerIds: [layer.id] });
    },

    addLayerAt: (layer, index) => {
      mutate((design) => {
        const layers = [...design.layers];
        layers.splice(Math.max(0, Math.min(index, layers.length)), 0, layer);
        return { layers };
      }, false);
      set({ selectedLayerIds: [layer.id] });
    },

    addImageLayer: (asset, naturalWidth, naturalHeight) => {
      const design = get().design;
      if (!design) {
        return;
      }
      get().addImageLayerAt(asset, naturalWidth, naturalHeight, design.width / 2, design.height / 2);
    },

    addImageLayerAt: (asset, naturalWidth, naturalHeight, centerX, centerY) => {
      const design = get().design;
      if (!design) {
        return;
      }
      const fit = Math.min(1, design.width / naturalWidth, design.height / naturalHeight);
      const width = Math.max(1, Math.round(naturalWidth * fit));
      const height = Math.max(1, Math.round(naturalHeight * fit));
      const layer: ImageLayer = {
        id: newLayerId(),
        type: "image",
        name: nextImageName(design.layers),
        x: Math.round(centerX - width / 2),
        y: Math.round(centerY - height / 2),
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        opacity: 1,
        visible: true,
        asset,
        width,
        height,
        shadow: defaultShadow(),
      };
      get().addLayer(layer);
    },

    addImageLayerAsBackground: (asset, naturalWidth, naturalHeight) => {
      const design = get().design;
      if (!design) {
        return;
      }
      // Cover-fit the whole canvas (like a CSS cover background), centered,
      // inserted at the bottom of the stack.
      const cover = Math.max(design.width / naturalWidth, design.height / naturalHeight);
      const width = Math.max(1, Math.round(naturalWidth * cover));
      const height = Math.max(1, Math.round(naturalHeight * cover));
      const layer: ImageLayer = {
        id: newLayerId(),
        type: "image",
        name: nextImageName(design.layers),
        x: Math.round((design.width - width) / 2),
        y: Math.round((design.height - height) / 2),
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        opacity: 1,
        visible: true,
        asset,
        width,
        height,
        shadow: defaultShadow(),
      };
      get().addLayerAt(layer, 0);
    },

    assetsVersion: 0,

    bumpAssetsVersion: () => {
      set((state) => ({ assetsVersion: state.assetsVersion + 1 }));
    },

    editingTextLayerId: null,

    setEditingTextLayer: (id) => {
      set({ editingTextLayerId: id });
    },

    editingFrameId: null,

    setEditingFrame: (id) => {
      set({ editingFrameId: id });
    },

    contextMenu: null,

    openContextMenu: (menu) => {
      set({ contextMenu: menu });
    },

    closeContextMenu: () => {
      set({ contextMenu: null });
    },

    bgRemoval: null,

    setBgRemoval: (value) => {
      set({ bgRemoval: value });
    },

    toast: null,

    showToast: (message) => {
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
      set({ toast: message });
      toastTimer = setTimeout(() => {
        set({ toast: null });
      }, 4000);
    },

    photoPalettes: {},

    setPhotoPalette: (key, colors) => {
      set((state) => ({ photoPalettes: { ...state.photoPalettes, [key]: colors } }));
    },

    updateLayer: (id, patch, transient = false) => {
      const target = get().design?.layers.find((layer) => layer.id === id);
      if (target?.locked && !patchAllowedOnLocked(patch)) {
        return;
      }
      mutate(
        (design) => ({
          // The patch only carries fields valid for the target's type; the
          // spread widens to the intersection, so narrow it back explicitly.
          layers: design.layers.map((layer) => (layer.id === id ? patchLayer(layer, patch) : layer)),
        }),
        transient,
      );
    },

    updateLayers: (entries) => {
      const design = get().design;
      if (!design) {
        return;
      }
      const allowed = entries.filter((entry) => {
        const layer = design.layers.find((candidate) => candidate.id === entry.id);
        return !layer?.locked || patchAllowedOnLocked(entry.patch);
      });
      if (allowed.length === 0) {
        return;
      }
      const patches = new Map(allowed.map((entry) => [entry.id, entry.patch]));
      mutate(
        (current) => ({
          layers: current.layers.map((layer) => {
            const patch = patches.get(layer.id);
            return patch ? patchLayer(layer, patch) : layer;
          }),
        }),
        false,
      );
    },

    toggleLockSelected: () => {
      const design = get().design;
      const ids = get().selectedLayerIds;
      if (!design || ids.length === 0) {
        return;
      }
      const selected = design.layers.filter((layer) => ids.includes(layer.id));
      if (selected.length === 0) {
        return;
      }
      const unlock = selected.every((layer) => layer.locked);
      get().updateLayers(selected.map((layer) => ({ id: layer.id, patch: { locked: !unlock } })));
    },

    commitTransient: () => {
      const pending = get().pendingSnapshot;
      if (!pending) {
        return;
      }
      set((state) => ({
        pendingSnapshot: null,
        past: [...state.past.slice(-(HISTORY_LIMIT - 1)), pending],
        future: [],
      }));
    },

    removeLayer: (id) => {
      const target = get().design?.layers.find((layer) => layer.id === id);
      if (target?.locked) {
        return;
      }
      mutate((design) => ({ layers: design.layers.filter((layer) => layer.id !== id) }), false);
      set((state) => ({ selectedLayerIds: state.selectedLayerIds.filter((entry) => entry !== id) }));
    },

    removeSelectedLayers: () => {
      const ids = get().selectedLayerIds;
      if (ids.length === 0) {
        return;
      }
      const design = get().design;
      // Locked layers survive Delete; unlocked ones are removed normally.
      const removable = new Set(
        design?.layers.filter((layer) => ids.includes(layer.id) && !layer.locked).map((layer) => layer.id),
      );
      if (removable.size === 0) {
        return;
      }
      mutate((current) => ({ layers: current.layers.filter((layer) => !removable.has(layer.id)) }), false);
      set((state) => ({ selectedLayerIds: state.selectedLayerIds.filter((entry) => !removable.has(entry)) }));
    },

    duplicateLayer: (id) => {
      set({ selectedLayerIds: [id] });
      get().duplicateSelectedLayers();
    },

    duplicateSelectedLayers: () => {
      const design = get().design;
      const ids = get().selectedLayerIds;
      if (!design || ids.length === 0) {
        return;
      }
      const selected = design.layers.filter((layer) => ids.includes(layer.id));
      const groupMap = new Map<string, string>();
      const clones = selected.map((layer) => {
        const clone: Layer = {
          ...structuredClone(layer),
          id: newLayerId(),
          name: `${layer.name} copy`,
          x: layer.x + 12,
          y: layer.y + 12,
        };
        if (clone.groupId) {
          let mapped = groupMap.get(clone.groupId);
          if (!mapped) {
            mapped = newLayerId();
            groupMap.set(clone.groupId, mapped);
          }
          clone.groupId = mapped;
        }
        return clone;
      });
      mutate((current) => ({ layers: [...current.layers, ...clones] }), false);
      set({ selectedLayerIds: clones.map((clone) => clone.id) });
    },

    copyLayer: (id) => {
      set({ selectedLayerIds: [id] });
      get().copySelectedLayers();
    },

    copySelectedLayers: () => {
      const design = get().design;
      const ids = get().selectedLayerIds;
      if (!design || ids.length === 0) {
        return;
      }
      layerClipboard = structuredClone(design.layers.filter((layer) => ids.includes(layer.id)));
    },

    pasteLayers: () => {
      const design = get().design;
      if (!design || layerClipboard.length === 0) {
        return;
      }
      const groupMap = new Map<string, string>();
      const clones = layerClipboard.map((layer) => {
        const clone: Layer = {
          ...structuredClone(layer),
          id: newLayerId(),
          name: `${layer.name} copy`,
          x: layer.x + 16,
          y: layer.y + 16,
        };
        if (clone.groupId) {
          let mapped = groupMap.get(clone.groupId);
          if (!mapped) {
            mapped = newLayerId();
            groupMap.set(clone.groupId, mapped);
          }
          clone.groupId = mapped;
        }
        return clone;
      });
      mutate((current) => ({ layers: [...current.layers, ...clones] }), false);
      set({ selectedLayerIds: clones.map((clone) => clone.id) });
    },

    copyTextStyle: (id) => {
      const layer = get().design?.layers.find((entry) => entry.id === id);
      if (layer?.type !== "text") {
        return;
      }
      const { fontFamily, fontSize, fontStyle, fill, align, lineHeight, letterSpacing,
        wrapWidth, curve, effect, shadow, stroke, opacity } = layer;
      set({ textStyleClipboard: structuredClone({ fontFamily, fontSize, fontStyle, fill, align,
        lineHeight, letterSpacing, wrapWidth, curve, effect, shadow, stroke, opacity }) });
      get().showToast("Text style copied");
    },

    pasteTextStyle: (id) => {
      const layer = get().design?.layers.find((entry) => entry.id === id);
      const style = get().textStyleClipboard;
      if (layer?.type !== "text" || layer.locked || !style) {
        return;
      }
      get().updateLayer(id, structuredClone(style));
      get().showToast("Text style pasted");
    },

    moveLayer: (id, direction) => {
      set({ selectedLayerIds: [id] });
      get().moveSelectedLayers(direction);
    },

    moveSelectedLayers: (direction) => {
      const design = get().design;
      // Z-order freeze: locked layers never move; unlocked layers pass
      // behind/in front of them normally.
      const ids = new Set(
        design?.layers
          .filter((layer) => get().selectedLayerIds.includes(layer.id) && !layer.locked)
          .map((layer) => layer.id),
      );
      if (ids.size === 0) {
        return;
      }
      mutate((design) => {
        const layers = [...design.layers];
        if (direction === 1) {
          for (let i = layers.length - 2; i >= 0; i -= 1) {
            const current = layers[i];
            const above = layers[i + 1];
            if (current && above && ids.has(current.id) && !ids.has(above.id)) {
              layers[i] = above;
              layers[i + 1] = current;
            }
          }
        } else {
          for (let i = 1; i < layers.length; i += 1) {
            const current = layers[i];
            const below = layers[i - 1];
            if (current && below && ids.has(current.id) && !ids.has(below.id)) {
              layers[i] = below;
              layers[i - 1] = current;
            }
          }
        }
        return { layers };
      }, false);
    },

    reorderLayerBlock: (sourceIds, targetIds, above) => {
      const design = get().design;
      if (!design || sourceIds.some((id) => targetIds.includes(id))) { return; }
      const source = new Set(sourceIds);
      const target = new Set(targetIds);
      if (design.layers.filter((layer) => source.has(layer.id)).length !== source.size ||
        design.layers.filter((layer) => target.has(layer.id)).length !== target.size ||
        design.layers.some((layer) => source.has(layer.id) && layer.locked)) { return; }
      const remaining = design.layers.filter((layer) => !source.has(layer.id));
      const targetIndices = remaining.flatMap((layer, index) => target.has(layer.id) ? [index] : []);
      if (targetIndices.length === 0) { return; }
      const insertAt = above ? Math.max(...targetIndices) + 1 : Math.min(...targetIndices);
      const moving = design.layers.filter((layer) => source.has(layer.id));
      const layers = [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];
      if (layers.every((layer, index) => layer.id === design.layers[index]?.id)) { return; }
      mutate(() => ({ layers }), false);
    },

    groupSelection: () => {
      const design = get().design;
      const ids = get().selectedLayerIds;
      if (!design || ids.length < 2) {
        return;
      }
      const groupId = newLayerId();
      mutate((current) => {
        const memberIndices = current.layers
          .map((layer, index) => (ids.includes(layer.id) ? index : -1))
          .filter((index) => index >= 0);
        if (memberIndices.length < 2) {
          return { layers: current.layers };
        }
        const members = memberIndices
          .map((index) => current.layers[index])
          .filter((layer): layer is Layer => Boolean(layer))
          .map((layer) => ({ ...layer, groupId }));
        const nonMembers = current.layers.filter((layer) => !ids.includes(layer.id));
        const topIndex = memberIndices[memberIndices.length - 1] ?? 0;
        const insertAt = Math.max(0, topIndex - (memberIndices.length - 1));
        return {
          layers: [...nonMembers.slice(0, insertAt), ...members, ...nonMembers.slice(insertAt)],
        };
      }, false);
    },

    ungroupSelection: () => {
      const design = get().design;
      const ids = get().selectedLayerIds;
      if (!design || ids.length === 0) {
        return;
      }
      const groupIds = new Set(
        design.layers.filter((layer) => ids.includes(layer.id) && layer.groupId).map((layer) => layer.groupId),
      );
      if (groupIds.size === 0) {
        return;
      }
      mutate(
        (current) => ({
          layers: current.layers.map((layer) =>
            layer.groupId && groupIds.has(layer.groupId) ? { ...layer, groupId: undefined } : layer),
        }),
        false,
      );
      set({ editingGroupId: null });
    },

    undo: () => {
      get().commitTransient();
      const state = get();
      const design = state.design;
      const previous = state.past[state.past.length - 1];
      if (!design || !previous) {
        return;
      }
      set({
        past: state.past.slice(0, -1),
        future: [...state.future, snapshotOf(design)],
      });
      restore(design, previous);
      markDirty();
    },

    redo: () => {
      const state = get();
      const design = state.design;
      const next = state.future[state.future.length - 1];
      if (!design || !next) {
        return;
      }
      set({
        future: state.future.slice(0, -1),
        past: [...state.past, snapshotOf(design)],
      });
      restore(design, next);
      markDirty();
    },

    saveNow: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const design = get().design;
      if (!design || get().saveStatus === "saved") {
        return;
      }
      // Claude is editing: nothing of ours can be saved until Luis takes over.
      if (get().lock?.holder === "agent") {
        return;
      }
      if (saveInFlight) {
        // One save at a time, so each starts from the revision the last one made.
        saveAgain = true;
        return;
      }
      saveInFlight = true;
      set({ saveStatus: "saving" });
      try {
        // The open page gets a fresh preview; the first page's preview also
        // represents the design in the project list.
        const activePageId = get().activePageId;
        const thumbnail = makeDesignThumbnail();
        const pages = syncedPages(design, activePageId).map((page) =>
          page.id === activePageId && thumbnail ? { ...page, thumbnail } : page);
        const { layers: _layers, background: _background, backgroundGradient: _gradient, ...meta } = design;
        const payload: DesignUpdate = {
          ...meta,
          pages,
          // The project list shows page 1; without its preview the server
          // keeps whatever it has.
          thumbnail: pages[0]?.thumbnail,
          // Explicit null so turning "format" off reaches the server.
          kind: design.kind ?? null,
          baseRevision: design.revision ?? 0,
        };
        const saved = await api.updateDesign(design.id, payload);
        const current = get().design;
        const savedAll = get().saveStatus === "saving";
        set({
          saveStatus: savedAll ? "saved" : get().saveStatus,
          unsavedEdits: savedAll ? false : get().unsavedEdits,
          ...(current
            ? {
                design: {
                  ...current,
                  updatedAt: saved.updatedAt,
                  revision: saved.revision,
                  thumbnail: payload.thumbnail ?? current.thumbnail,
                  // Keep the new preview without touching newer edits.
                  pages: current.pages.map((page) =>
                    page.id === activePageId && thumbnail ? { ...page, thumbnail } : page),
                },
              }
            : {}),
        });
      } catch (error) {
        set({ saveStatus: "dirty" });
        if (error instanceof ApiError && error.status === 423) {
          set({ lock: (error.body as { lock?: DesignLock } | undefined)?.lock ?? null });
        } else if (error instanceof ApiError && error.status === 409) {
          saveInFlight = false;
          saveAgain = false;
          await get().syncFromServer("This design changed elsewhere, so your last change wasn't saved. It now shows the latest version.");
          return;
        }
      } finally {
        saveInFlight = false;
      }
      if (saveAgain) {
        saveAgain = false;
        if (get().saveStatus === "dirty") {
          void get().saveNow();
        }
      }
    },

    setActivePage: (pageId) => {
      const state = get();
      const design = state.design;
      if (!design || pageId === state.activePageId || !design.pages.some((page) => page.id === pageId)) {
        return;
      }
      state.commitTransient();
      // Keep the strip's preview of the page being left current.
      const pages = syncedPages(design, state.activePageId, makeDesignThumbnail());
      set({
        design: withActivePage({ ...design, pages }, pageId),
        activePageId: pageId,
        selectedLayerIds: [],
        editingGroupId: null,
        editingTextLayerId: null,
        editingFrameId: null,
        contextMenu: null,
      });
    },

    addPage: (options = {}) => {
      changePages((pages, activePageId) => {
        const index = pages.findIndex((page) => page.id === activePageId);
        const current = pages[index];
        if (!current) {
          return null;
        }
        const content: PageContent = options.duplicate
          ? clonePageContent(current)
          : { background: current.background, backgroundGradient: structuredClone(current.backgroundGradient), layers: [] };
        const page: DesignPage = { id: newLayerId(), ...content, thumbnail: options.duplicate ? current.thumbnail : undefined };
        return { pages: [...pages.slice(0, index + 1), page, ...pages.slice(index + 1)], activePageId: page.id };
      });
    },

    deletePage: (pageId) => {
      changePages((pages, activePageId) => {
        const index = pages.findIndex((page) => page.id === pageId);
        if (index < 0 || pages.length <= 1) {
          return null;
        }
        const remaining = pages.filter((page) => page.id !== pageId);
        const neighbor = remaining[Math.min(index, remaining.length - 1)];
        return {
          pages: remaining,
          activePageId: pageId === activePageId ? (neighbor?.id ?? activePageId) : activePageId,
        };
      });
    },

    movePage: (pageId, toIndex) => {
      changePages((pages, activePageId) => {
        const from = pages.findIndex((page) => page.id === pageId);
        const to = Math.max(0, Math.min(pages.length - 1, toIndex));
        const page = pages[from];
        if (!page || from === to) {
          return null;
        }
        const rest = pages.filter((entry) => entry.id !== pageId);
        return { pages: [...rest.slice(0, to), page, ...rest.slice(to)], activePageId };
      });
    },

    setDesignKind: (kind) => {
      const design = get().design;
      if (!design || design.kind === kind) {
        return;
      }
      set({ design: { ...design, kind } });
      markDirty();
    },

    updateLayersOnAnyPage: (entries) => {
      const patches = new Map(entries.map((entry) => [entry.id, entry.patch]));
      changePages((pages, activePageId) => ({
        pages: pages.map((page) => ({
          ...page,
          layers: page.layers.map((layer) => {
            const patch = patches.get(layer.id);
            return patch && !(layer.locked && !patchAllowedOnLocked(patch)) ? patchLayer(layer, patch) : layer;
          }),
        })),
        activePageId,
      }));
    },

    setFormatAi: (formatAi) => {
      const design = get().design;
      if (!design) {
        return;
      }
      set({ design: { ...design, formatAi } });
      markDirty();
    },

    redrawBlocks: (pages, blocks) => {
      const redrawn = new Map(pages.map((page) => [page.id, page]));
      changePages((current, activePageId) => ({
        pages: current.map((page) => {
          const next = redrawn.get(page.id);
          return next ? { ...next, thumbnail: page.thumbnail } : page;
        }),
        activePageId,
      }));
      const design = get().design;
      if (design) {
        set({ design: { ...design, blocks } });
      }
    },

    replacePages: (pages, source) => {
      const first = pages[0];
      if (!first) {
        return;
      }
      changePages(() => ({ pages, activePageId: first.id }));
      const design = get().design;
      if (design && source) {
        set({ design: { ...design, source } });
      }
    },
  };
});

// Dev builds only: lets the browser console inspect editor state.
if (import.meta.env.DEV) {
  (window as unknown as { __mycanvasStore?: typeof useEditorStore }).__mycanvasStore = useEditorStore;
}

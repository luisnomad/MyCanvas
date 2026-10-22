import { create } from "zustand";

/** Editor view preferences (per browser, not part of the design). */
export interface ViewSettings {
  showGrid: boolean;
  /** Grid spacing in design px. */
  gridSize: number;
  snapToGrid: boolean;
  smartGuides: boolean;
}

interface ViewSettingsStore extends ViewSettings {
  setView: (patch: Partial<ViewSettings>) => void;
}

const STORAGE_KEY = "mycanvas-view";
const DEFAULTS: ViewSettings = { showGrid: false, gridSize: 40, snapToGrid: false, smartGuides: true };

function load(): ViewSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ViewSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const useViewSettings = create<ViewSettingsStore>()((set, get) => ({
  ...load(),
  setView: (patch) => {
    set(patch);
    const { showGrid, gridSize, snapToGrid, smartGuides } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ showGrid, gridSize, snapToGrid, smartGuides }));
    } catch {
      // Storage unavailable (private mode); settings last for the session.
    }
  },
}));

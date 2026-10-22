import { useEditorStore } from "../store/editorStore";
import { getLayerNode } from "./canvas-bridge";

export type Axis = "x" | "y";
export type AlignMode = "min" | "center" | "max";

interface Entity {
  layerIds: string[];
  /** Rendered bounds in design px (rotation/effects included). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The selection as movable units: a group not currently entered moves as
 * one, everything else on its own. Bounds come from the rendered Konva nodes,
 * like align-to-page, so auto-sized text and rotated layers line up visually.
 */
function selectionEntities(): Entity[] {
  const state = useEditorStore.getState();
  const design = state.design;
  if (!design) {
    return [];
  }
  const byKey = new Map<string, Entity>();
  for (const id of state.selectedLayerIds) {
    const layer = design.layers.find((entry) => entry.id === id);
    const node = getLayerNode(id);
    if (!layer?.visible || !node) {
      continue;
    }
    const rect = node.getClientRect({ skipShadow: true });
    const key = layer.groupId && layer.groupId !== state.editingGroupId ? `group:${layer.groupId}` : id;
    const existing = byKey.get(key);
    if (existing) {
      const right = Math.max(existing.x + existing.width, rect.x + rect.width);
      const bottom = Math.max(existing.y + existing.height, rect.y + rect.height);
      existing.x = Math.min(existing.x, rect.x);
      existing.y = Math.min(existing.y, rect.y);
      existing.width = right - existing.x;
      existing.height = bottom - existing.y;
      existing.layerIds.push(id);
    } else {
      byKey.set(key, { layerIds: [id], x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
  }
  return [...byKey.values()];
}

/** Moves each entity by its delta in one undoable step (locked layers stay). */
function applyDeltas(moves: { entity: Entity; delta: number }[], axis: Axis): void {
  const state = useEditorStore.getState();
  const design = state.design;
  if (!design) {
    return;
  }
  const entries = moves.flatMap(({ entity, delta }) => {
    if (Math.abs(delta) < 0.01) {
      return [];
    }
    return entity.layerIds.flatMap((id) => {
      const layer = design.layers.find((entry) => entry.id === id);
      return layer ? [{ id, patch: { [axis]: Math.round(layer[axis] + delta) } }] : [];
    });
  });
  if (entries.length > 0) {
    state.updateLayers(entries);
  }
}

export function canAlignSelection(): boolean {
  return selectionEntities().length >= 2;
}

export function canDistributeSelection(): boolean {
  return selectionEntities().length >= 3;
}

/** Aligns the selected items to each other (the selection's bounding box). */
export function alignSelection(axis: Axis, mode: AlignMode): void {
  const entities = selectionEntities();
  if (entities.length < 2) {
    return;
  }
  const size = axis === "x" ? "width" : "height";
  const min = Math.min(...entities.map((entity) => entity[axis]));
  const max = Math.max(...entities.map((entity) => entity[axis] + entity[size]));
  applyDeltas(entities.map((entity) => {
    const target = mode === "min"
      ? min
      : mode === "max"
        ? max - entity[size]
        : (min + max) / 2 - entity[size] / 2;
    return { entity, delta: target - entity[axis] };
  }), axis);
}

/** Equal gaps between 3+ items; the outermost two stay put. */
export function distributeSelection(axis: Axis): void {
  const entities = selectionEntities();
  if (entities.length < 3) {
    return;
  }
  const size = axis === "x" ? "width" : "height";
  const sorted = [...entities].sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) {
    return;
  }
  const span = last[axis] + last[size] - first[axis];
  const occupied = sorted.reduce((sum, entity) => sum + entity[size], 0);
  const gap = (span - occupied) / (sorted.length - 1);
  let cursor = first[axis];
  applyDeltas(sorted.map((entity) => {
    const delta = cursor - entity[axis];
    cursor += entity[size] + gap;
    return { entity, delta };
  }), axis);
}

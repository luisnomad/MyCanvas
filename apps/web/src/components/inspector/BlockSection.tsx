import { useState } from "react";
import { type BlockDesign, type BlockTheme, type BlockVariant, type VisualBlockType, type VisualPart } from "@mycanvas/shared";
import { syncedPages, useEditorStore } from "../../store/editorStore";
import { BLOCKS, BLOCK_LIST, convertSlots, variantFor } from "../../utils/blocks/catalog";
import { THEMES } from "../../utils/blocks/themes";
import { Panel } from "./Panel";

const ALIGN_LABELS: Record<BlockVariant["align"], string> = { left: "Left", center: "Centre", right: "Right" };
const ACCENT_LABELS: Record<BlockVariant["accent"], string> = { plain: "Plain", tint: "Tinted", bold: "Bold" };
const SIDE_LABELS: Record<NonNullable<BlockVariant["side"]>, string> = { top: "Top", left: "Left", right: "Right" };
const ARRANGE_LABELS: Record<NonNullable<BlockVariant["arrange"]>, string> = { list: "List", row: "Row", grid: "Grid" };

function Choices<T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void }) {
  return (
    <div className="field block-choices" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      <div className="segmented">
        {options.map((option) => (
          <button key={option} type="button" role="radio" aria-checked={option === value} className={option === value ? "active" : ""} onClick={() => { onChange(option); }}>
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Pages made from visual blocks: switch the page's block and its layout
 * options, or the whole design's theme. Text edited on the canvas and
 * pictures dropped into frames are kept; layers moved by hand are redrawn.
 */
export function BlockSection() {
  const design = useEditorStore((state) => state.design);
  const activePageId = useEditorStore((state) => state.activePageId);
  const redrawBlocks = useEditorStore((state) => state.redrawBlocks);
  const showToast = useEditorStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const blocks = design?.blocks;
  const part = blocks?.parts.find((entry) => entry.pageId === activePageId);
  if (!design || !blocks || !part) {
    return null;
  }

  /** Redraws the given parts (with canvas edits read back) under a new block record. */
  const redraw = async (next: BlockDesign, partIds: Set<string>) => {
    setBusy(true);
    try {
      const { drawParts, partsWithEdits } = await import("../../utils/blocks/build");
      const pages = syncedPages(design, activePageId);
      const order = pages.map((page) => page.id);
      const edited = partsWithEdits(blocks, pages);
      // Edits made on the canvas are in the old record's slots; keep the new block/variant.
      const parts = next.parts.map((entry) => {
        const before = edited.find((candidate) => candidate.id === entry.id);
        return before?.block === entry.block ? { ...entry, slots: before.slots } : entry;
      });
      const toDraw = parts.filter((entry) => partIds.has(entry.id) && order.includes(entry.pageId));
      const drawn = await drawParts(toDraw, next.theme, design.width, design.height, (entry) => ({ pageNumber: order.indexOf(entry.pageId) + 1, pageCount: order.length }));
      redrawBlocks(drawn.pages, { ...next, parts });
      if (drawn.overflowing.length > 0) {
        showToast(`Text is long for this block on page ${drawn.overflowing.join(", ")}, so it was drawn smaller.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const changePart = (change: (current: VisualPart) => VisualPart) => {
    const pages = syncedPages(design, activePageId);
    // Start from what's on the canvas now, so switching blocks carries edits along.
    const page = pages.find((entry) => entry.id === part.pageId);
    void import("../../utils/blocks/render").then(({ readSlots }) => {
      const current = page ? { ...part, slots: readSlots(part, page.layers) } : part;
      const nextPart = change(current);
      void redraw({ ...blocks, parts: blocks.parts.map((entry) => (entry.id === part.id ? nextPart : entry)) }, new Set([part.id]));
    });
  };

  const switchBlock = (block: VisualBlockType) => {
    changePart((current) => {
      const { slots, leftOver } = convertSlots(current.slots, block);
      if (leftOver.length > 0) {
        showToast(`${BLOCKS[block].label} has no place for: “${leftOver.join("”, “").slice(0, 140)}”. Undo brings it back.`);
      }
      return { ...current, block, slots, variant: variantFor(block, current.variant) };
    });
  };

  const setVariant = (patch: Partial<BlockVariant>) => {
    changePart((current) => ({ ...current, variant: variantFor(current.block, { ...current.variant, ...patch }) }));
  };

  const setTheme = (theme: BlockTheme) => {
    void redraw({ ...blocks, theme }, new Set(blocks.parts.map((entry) => entry.id)));
  };

  const spec = BLOCKS[part.block];
  const themes = THEMES.some((theme) => theme.id === blocks.theme.id) ? THEMES : [blocks.theme, ...THEMES];
  const aligns = spec.aligns ?? (["left", "center", "right"] as const);

  return (
    <Panel title="Page block">
      <fieldset className="block-section" disabled={busy}>
        <label className="field">
          <span>Block</span>
          <select value={part.block} onChange={(e) => { switchBlock(e.target.value as VisualBlockType); }}>
            {BLOCK_LIST.map((entry) => <option key={entry.type} value={entry.type}>{entry.label}</option>)}
          </select>
        </label>
        <p className="muted block-hint">
          {spec.description}
          .
        </p>
        {aligns.length > 1 && <Choices label="Align" value={part.variant.align} options={aligns} labels={ALIGN_LABELS} onChange={(align) => { setVariant({ align }); }} />}
        <Choices label="Background" value={part.variant.accent} options={["plain", "tint", "bold"] as const} labels={ACCENT_LABELS} onChange={(accent) => { setVariant({ accent }); }} />
        {spec.sides && (part.block === "pictureText" || part.slots.image) && (
          <Choices label="Picture" value={part.variant.side ?? spec.sides[0] ?? "top"} options={spec.sides} labels={SIDE_LABELS} onChange={(side) => { setVariant({ side }); }} />
        )}
        {spec.arranges && <Choices label="Arrange" value={part.variant.arrange ?? spec.arranges[0] ?? "list"} options={spec.arranges} labels={ARRANGE_LABELS} onChange={(arrange) => { setVariant({ arrange }); }} />}
        <label className="field">
          <span>Theme (all pages)</span>
          <select
            value={blocks.theme.id}
            onChange={(e) => {
              const theme = themes.find((entry) => entry.id === e.target.value);
              if (theme) {
                setTheme(theme);
              }
            }}
          >
            {themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
          </select>
        </label>
        <p className="muted block-hint">Your text edits and pictures stay when the page is redrawn; layers you moved or added by hand don&apos;t.</p>
      </fieldset>
    </Panel>
  );
}

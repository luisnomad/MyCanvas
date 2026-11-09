import { BLOCK_KINDS, type BlockKind, type FormatRole, type Layer } from "@mycanvas/shared";
import { type LayerPatch } from "../../store/editorStore";
import { NumberField } from "./fields";
import { Panel } from "./Panel";

interface FormatRoleSectionProps {
  layer: Layer;
  patch: (patch: LayerPatch, transient?: boolean) => void;
  commit: () => void;
}

const DEFAULT_SPACE: Record<BlockKind, number> = {
  title: 0,
  lead: 24,
  heading: 32,
  body: 16,
  callout: 20,
  image: 24,
};

/** Select value ↔ role. */
function roleKey(role: FormatRole | undefined): string {
  switch (role?.kind) {
    case undefined:
      return "decoration";
    case "flow":
      return "flow";
    case "hideOnLast":
      return "hideOnLast";
    case "sample":
      return `sample:${role.block}`;
    case "box":
      return `box:${role.block}`;
  }
}

function roleFromKey(key: string, current: FormatRole | undefined): FormatRole | undefined {
  if (key === "flow") {
    return { kind: "flow" };
  }
  if (key === "hideOnLast") {
    return { kind: "hideOnLast" };
  }
  const [kind, block] = key.split(":") as [string, BlockKind | undefined];
  if (kind === "sample" && block) {
    const spaceBefore = current?.kind === "sample" ? current.spaceBefore : DEFAULT_SPACE[block];
    return { kind: "sample", block, spaceBefore };
  }
  if (kind === "box" && block) {
    return { kind: "box", block };
  }
  return undefined;
}

const HINTS: Record<string, string> = {
  decoration: "Repeats on every page made from this master page.",
  hideOnLast: "Repeats on every page except the document's last one (e.g. a \"next page\" arrow).",
  flow: "Content flows top to bottom inside this rectangle, then continues on a new page. It isn't part of the documents.",
  sample: "Shows how this kind of block looks. Its font, size, color and effects, and its distance from the flow area's edges, apply to every block of this kind.",
  box: "Drawn behind every block of this kind, with the same padding as around the sample.",
};

/**
 * Inside a document format: what this layer does when content is laid out
 * (decoration, flow area, block sample or block box).
 */
export function FormatRoleSection({ layer, patch, commit }: FormatRoleSectionProps) {
  const role = layer.formatRole;
  const key = roleKey(role);
  const textKinds = BLOCK_KINDS.filter((kind) => kind.id !== "image");

  return (
    <Panel title="Role in format">
      <label className="field field-wide">
        <span>This layer is</span>
        <select
          value={key}
          onChange={(e) => {
            patch({ formatRole: roleFromKey(e.target.value, role) });
          }}
        >
          <option value="decoration">Decoration (every page)</option>
          <option value="hideOnLast">Decoration, not on the last page</option>
          {layer.type === "rect" && <option value="flow">Flow area</option>}
          {layer.type === "text" && textKinds.map((kind) => (
            <option key={kind.id} value={`sample:${kind.id}`}>{`Sample: ${kind.label}`}</option>
          ))}
          {layer.type === "image" && <option value="sample:image">Sample: Image</option>}
          {layer.type === "rect" && textKinds.map((kind) => (
            <option key={kind.id} value={`box:${kind.id}`}>{`Box behind: ${kind.label}`}</option>
          ))}
        </select>
      </label>
      {role?.kind === "sample" && (
        <NumberField
          label="Space before (px)"
          value={role.spaceBefore}
          min={0}
          max={400}
          onChange={(spaceBefore) => { patch({ formatRole: { ...role, spaceBefore } }, true); }}
          onCommit={commit}
        />
      )}
      <p className="muted panel-hint">{HINTS[key.split(":")[0] ?? "decoration"]}</p>
    </Panel>
  );
}

import { useEffect } from "react";

const MOD = /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

const GROUPS: { title: string; items: [keys: string, action: string][] }[] = [
  {
    title: "Edit",
    items: [
      [`${MOD} Z`, "Undo"],
      [`${MOD} ⇧ Z`, "Redo"],
      [`${MOD} C`, "Copy"],
      [`${MOD} V`, "Paste"],
      [`${MOD} D`, "Duplicate"],
      ["Delete", "Delete selection"],
    ],
  },
  {
    title: "Arrange",
    items: [
      [`${MOD} G`, "Group"],
      [`${MOD} ⇧ G`, "Ungroup"],
      [`${MOD} ⇧ L`, "Lock / unlock"],
      ["Arrows", "Nudge 1 px"],
      ["⇧ Arrows", "Nudge 10 px"],
    ],
  },
  {
    title: "Selection & text",
    items: [
      ["⇧ Click", "Add to / remove from selection"],
      ["Drag on empty canvas", "Marquee select"],
      ["Double-click", "Edit text · enter group · edit frame image"],
      ["Enter", "Edit selected text"],
      ["Esc", "Leave group / finish editing"],
    ],
  },
  {
    title: "View",
    items: [
      ["'", "Show / hide grid"],
      ["?", "This list"],
    ],
  },
];

/** Keyboard reference, opened with "?" or the bottom-bar button. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog shortcuts-dialog"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2>Keyboard shortcuts</h2>
        <div className="shortcuts-grid">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map(([keys, action]) => (
                  <div key={action} className="shortcut-row">
                    <dt>{action}</dt>
                    <dd><kbd>{keys}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { type AssetInfo, type AssetUsage } from "@mycanvas/shared";
import { usageOf } from "./library";

interface DeleteAssetsDialogProps {
  items: AssetInfo[];
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirms deleting uploads. When any are still used, lists the designs and
 * templates that will show a missing image afterwards.
 */
export function DeleteAssetsDialog({ items, onCancel, onConfirm }: DeleteAssetsDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const affected = new Map<string, AssetUsage>();
  for (const info of items) {
    for (const use of usageOf(info)) {
      affected.set(`${use.kind}:${use.id}`, use);
    }
  }
  const single = items.length === 1 ? items[0] : undefined;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop dialog-backdrop-top"
      onClick={(e) => {
        // Don't let the click reach a manager window underneath.
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="dialog delete-assets-dialog"
        role="alertdialog"
        aria-label="Delete uploads"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2>{single ? `Delete “${single.name}”?` : `Delete ${String(items.length)} uploads?`}</h2>
        {affected.size === 0
          ? <p className="muted">Not used in any design. This can't be undone.</p>
          : (
              <>
                <p>
                  {single ? "This image is" : "Some of these images are"}
                  {" "}
                  used in
                  {" "}
                  {affected.size === 1 ? "1 place" : `${String(affected.size)} places`}
                  . Those layers will show a missing image. This can't be undone.
                </p>
                <ul className="usage-list">
                  {[...affected.values()].map((use) => (
                    <li key={`${use.kind}:${use.id}`}>
                      <span className="usage-kind">{use.kind}</span>
                      {use.name}
                    </li>
                  ))}
                </ul>
              </>
            )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onConfirm().catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : "Delete failed");
                setBusy(false);
              });
            }}
          >
            {busy ? "Deleting…" : affected.size > 0 ? "Delete anyway" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { api } from "../api";
import { useEditorStore } from "../store/editorStore";
import { makeDesignThumbnail } from "../utils/canvas-bridge";

/** Top-bar action: snapshot the current design into the template library. */
export function SaveTemplateButton() {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const store = useEditorStore.getState();
    const design = store.design;
    if (!design || saving) {
      return;
    }
    setSaving(true);
    try {
      // The server snapshots what's on disk, so flush pending edits first.
      await store.saveNow();
      if (useEditorStore.getState().saveStatus === "dirty") {
        store.showToast("Couldn't save the design, so no template was made");
        return;
      }
      const template = await api.saveTemplate(design.id, design.name, makeDesignThumbnail() ?? undefined);
      store.showToast(`Saved "${template.name}" as a template`);
    } catch {
      store.showToast("Couldn't save the template");
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      className="secondary"
      disabled={saving}
      title="Save this design as a reusable template"
      onClick={() => {
        void save();
      }}
    >
      {saving ? "Saving…" : "Save as template"}
    </button>
  );
}

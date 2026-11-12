import { useCallback, useEffect, useState } from "react";
import { Brand } from "../components/Brand";
import { CanvasStage } from "../components/CanvasStage";
import { ContextBar } from "../components/ContextBar";
import { ContextMenu } from "../components/ContextMenu";
import { AgentEditingBanner, LeaveLockedDialog, LockStatus } from "../components/DesignLock";
import { ExportDialog } from "../components/ExportDialog";
import { Inspector } from "../components/Inspector";
import { LayersPanel } from "../components/LayersPanel";
import { LeftToolbar } from "../components/LeftToolbar";
import { SaveTemplateButton } from "../components/SaveTemplateButton";
import { ShortcutsDialog } from "../components/ShortcutsDialog";
import { ThemeToggle } from "../components/ThemeToggle";
import { UserBadge } from "../components/UserBadge";
import { ViewMenu } from "../components/ViewMenu";
import { FormatMenu } from "../components/formats/FormatMenu";
import { PageNav } from "../components/pages/PageNav";
import { PagesStrip } from "../components/pages/PagesStrip";
import { useEditorStore } from "../store/editorStore";
import { useViewSettings } from "../store/viewSettings";
import { api } from "../api";
import { folderViewHash } from "../utils/folders";
import { makeDesignThumbnail } from "../utils/canvas-bridge";
import { leaveTo, setLeaveGuard } from "../utils/leave-guard";
import { onLive } from "../utils/live";

export function Editor({ designId }: { designId: string }) {
  const design = useEditorStore((state) => state.design);
  const loadStatus = useEditorStore((state) => state.loadStatus);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const setName = useEditorStore((state) => state.setName);
  const toast = useEditorStore((state) => state.toast);
  const lockHolder = useEditorStore((state) => state.lock?.holder ?? null);
  /** Claude holds the lock: the editor only shows its changes. */
  const viewOnly = lockHolder === "agent";
  const [leaveTarget, setLeaveTarget] = useState<string | null>(null);

  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const pageCount = useEditorStore((state) => state.design?.pages.length ?? 0);
  const [stripOpen, setStripOpen] = useState(false);
  // Show the page thumbnails as soon as a design has more than one page.
  useEffect(() => {
    if (pageCount > 1) {
      setStripOpen(true);
    }
  }, [pageCount]);
  const designFolderId = useEditorStore((state) => state.design?.folderId);
  const [folderName, setFolderName] = useState<string | null>(null);

  // Breadcrumb: the design's project folder, linking back to it.
  useEffect(() => {
    if (!designFolderId) {
      setFolderName(null);
      return;
    }
    let cancelled = false;
    void api
      .listFolders()
      .then((folders) => {
        if (!cancelled) {
          setFolderName(folders.find((folder) => folder.id === designFolderId)?.name ?? null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [designFolderId]);
  const [textPropertiesRequest, setTextPropertiesRequest] = useState(0);

  const loadDesign = useEditorStore((state) => state.loadDesign);
  const unload = useEditorStore((state) => state.unload);

  useEffect(() => {
    setZoom(null);
    void loadDesign(designId);
    return () => {
      unload();
    };
  }, [designId, loadDesign, unload]);

  // Live updates: changes saved elsewhere (Claude, another tab) and lock
  // changes appear without reloading.
  useEffect(() => {
    return onLive((event) => {
      const state = useEditorStore.getState();
      const open = state.design;
      if (event.type === "assets.changed") {
        state.bumpAssetsVersion();
        return;
      }
      if (event.type === "reconnected") {
        // Catch up on anything missed while disconnected.
        void api.getLock(designId).then((lock) => { useEditorStore.getState().setLock(lock); }).catch(() => undefined);
        if (open && state.saveStatus === "saved") {
          void state.syncFromServer();
        }
        return;
      }
      if (!("id" in event) || event.id !== designId) {
        return;
      }
      if (event.type === "lock.changed") {
        const before = state.lock;
        state.setLock(event.lock);
        if (before?.holder === "human" && event.lock === null) {
          state.showToast("The design was unlocked at your request.");
        }
        return;
      }
      if (event.type === "design.updated" && open) {
        if (event.revision <= (open.revision ?? 0)) {
          return; // This tab's own save, or already shown.
        }
        // Unsaved edits of ours: their save will notice the newer version
        // (409) and bring it in, unless Claude holds the lock, in which case
        // they can't be saved at all.
        if (state.saveStatus === "saved" || state.lock?.holder === "agent") {
          void state.syncFromServer(state.unsavedEdits ? `${state.lock?.label ?? "Claude"} changed the design, so your unsaved change was dropped.` : undefined);
        }
      }
    });
  }, [designId]);

  // Leaving while the design is still locked to you: ask first (in-app),
  // or let the browser ask (closing or reloading the tab).
  useEffect(() => {
    const ownHash = `#/edit/${designId}`;
    setLeaveGuard((target) => {
      if (target === ownHash || useEditorStore.getState().lock?.holder !== "human") {
        return false;
      }
      setLeaveTarget(target === "" ? "#/" : target);
      return true;
    });
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditorStore.getState().lock?.holder === "human") {
        e.preventDefault();
        // Older browsers need returnValue set to show the prompt.
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [designId]);

  const handleFitScale = useCallback((fit: number) => {
    setFitScale((prev) => (Math.abs(prev - fit) < 0.001 ? prev : fit));
  }, []);

  // Keyboard shortcuts: undo/redo, copy/paste, delete, arrow-key nudge.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useEditorStore.getState();
      const target = e.target;
      // Only text-entry controls should swallow shortcuts. Sliders, checkboxes,
      // color inputs and buttons may keep focus after a click and must not
      // silently disable copy/paste while a layer is selected.
      const inField =
        target instanceof HTMLElement &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          (target instanceof HTMLInputElement &&
            !["range", "checkbox", "radio", "color", "button"].includes(target.type)));
      const mod = e.metaKey || e.ctrlKey;
      // Frame content-edit mode owns the keyboard (CanvasStage commits on
      // Enter/Escape); keep Delete/arrows/undo inert while panning content.
      if (state.editingFrameId) {
        return;
      }
      // Claude is editing: only viewing shortcuts (pages, rulers, grid, help).
      if (state.lock?.holder === "agent") {
        const viewing = !mod && (e.key === "PageUp" || e.key === "PageDown" || e.key === "?" || e.key === "'" || (e.shiftKey && e.key.toLowerCase() === "r"));
        if (!viewing) {
          return;
        }
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          state.redo();
        } else {
          state.undo();
        }
        return;
      }
      if (inField || !state.design) {
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        state.addPage();
        return;
      }
      if (!mod && (e.key === "PageUp" || e.key === "PageDown")) {
        e.preventDefault();
        const pages = state.design.pages;
        const index = pages.findIndex((page) => page.id === state.activePageId);
        const target = pages[index + (e.key === "PageUp" ? -1 : 1)];
        if (target) {
          state.setActivePage(target.id);
        }
        return;
      }
      if (!mod && e.key === "?") {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
        return;
      }
      if (!mod && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        const view = useViewSettings.getState();
        view.setView({ showRulers: !view.showRulers });
        return;
      }
      if (!mod && e.key === "'") {
        e.preventDefault();
        const view = useViewSettings.getState();
        view.setView({ showGrid: !view.showGrid });
        return;
      }
      const hasSelection = state.selectedLayerIds.length > 0;
      if (mod && e.key.toLowerCase() === "c" && hasSelection) {
        e.preventDefault();
        state.copySelectedLayers();
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        state.pasteLayers();
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && hasSelection) {
        e.preventDefault();
        state.duplicateSelectedLayers();
        return;
      }
      if (mod && e.key.toLowerCase() === "g" && hasSelection) {
        e.preventDefault();
        if (e.shiftKey) {
          state.ungroupSelection();
        } else {
          state.groupSelection();
        }
        return;
      }
      // Cmd/Ctrl+Shift+L toggles layer locking (plain Cmd+L is the browser's
      // omnibox shortcut and can't be intercepted).
      if (mod && e.shiftKey && e.key.toLowerCase() === "l" && hasSelection) {
        e.preventDefault();
        state.toggleLockSelected();
        return;
      }
      if (e.key === "Escape" && state.editingGroupId) {
        // Leave the entered group: back to group-level selection.
        const groupId = state.editingGroupId;
        state.setEditingGroup(null);
        state.setSelectedLayers(
          state.design.layers.filter((entry) => entry.groupId === groupId).map((entry) => entry.id),
        );
        return;
      }
      if (!hasSelection) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        state.removeSelectedLayers();
        return;
      }
      const primaryId = state.selectedLayerIds[state.selectedLayerIds.length - 1];
      if (e.key === "Enter") {
        const layer = state.design.layers.find((entry) => entry.id === primaryId);
        if (state.selectedLayerIds.length === 1 && layer?.type === "text") {
          e.preventDefault();
          state.setEditingTextLayer(primaryId ?? null);
        }
        return;
      }
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        state.updateLayers(
          state.selectedLayerIds.flatMap((id) => {
            const layer = state.design?.layers.find((entry) => entry.id === id);
            return layer ? [{ id, patch: { x: layer.x + dx, y: layer.y + dy } }] : [];
          }),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Prevent the browser's default "open the file" navigation when files are
  // dropped anywhere on the editor outside the canvas drop zone.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Best-effort save when leaving the page with unsaved changes.
  useEffect(() => {
    const onBeforeUnload = () => {
      const state = useEditorStore.getState();
      const current = state.design;
      if (!current || state.saveStatus === "saved" || state.lock?.holder === "agent") {
        return;
      }
      const thumbnail = makeDesignThumbnail();
      const payload = { ...current, ...(thumbnail ? { thumbnail } : {}), baseRevision: current.revision ?? 0 };
      void fetch(`/api/designs/${encodeURIComponent(current.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  if (loadStatus === "loading") {
    return (
      <div className="editor-status">
        <p className="muted">Loading design…</p>
      </div>
    );
  }

  if (loadStatus === "not-found") {
    return (
      <div className="editor-status">
        <p>Design not found.</p>
        <a className="button-link" href="#/">
          Back to projects
        </a>
      </div>
    );
  }

  if (loadStatus === "error" || !design) {
    return (
      <div className="editor-status">
        <p>Failed to load the design. Is the server running?</p>
        <a className="button-link" href="#/">
          Back to projects
        </a>
      </div>
    );
  }

  const effectiveScale = zoom ?? fitScale;
  const zoomPercent = Math.round(effectiveScale * 100);

  const saveLabel =
    saveStatus === "saved"
      ? "Saved"
      : saveStatus === "saving"
        ? "Saving…"
        : "Unsaved changes";

  return (
    <div className="editor">
      <header className="editor-top">
        <Brand />
        <span className="top-bar-divider" aria-hidden="true" />
        {folderName && design.folderId && (
          <>
            <a
              className="editor-folder-link"
              href={folderViewHash({ kind: "folder", id: design.folderId })}
              title={`Back to ${folderName}`}
            >
              {folderName}
            </a>
            <span className="editor-folder-sep" aria-hidden="true">›</span>
          </>
        )}
        <input
          className="design-name"
          value={design.name}
          readOnly={viewOnly}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <span className={`save-pill ${saveStatus}`}>
          <span className="save-dot" aria-hidden="true" />
          {saveLabel}
        </span>
        <LockStatus />
        <span className="top-bar-spacer" />
        <ThemeToggle />
        <div className="view-only-scope" inert={viewOnly}>
          <FormatMenu />
          <SaveTemplateButton />
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setShowExport(true);
          }}
        >
          Export
        </button>
        <UserBadge />
      </header>
      <div className={viewOnly ? "editor-main view-only" : "editor-main"}>
        <div className="view-only-scope" inert={viewOnly}>
          <LeftToolbar textPropertiesRequest={textPropertiesRequest} />
        </div>
        <main className="editor-center">
          <AgentEditingBanner />
          <div className="view-only-scope" inert={viewOnly}>
            <ContextBar onOpenTextProperties={() => { setTextPropertiesRequest((request) => request + 1); }} />
            <div className="canvas-wrap">
              <CanvasStage design={design} scale={effectiveScale} onFitScale={handleFitScale} />
            </div>
            {stripOpen && <PagesStrip />}
          </div>
          <div className="editor-bottom">
            <button
              type="button"
              className="secondary"
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              onClick={() => { setShowShortcuts(true); }}
            >
              ?
            </button>
            <ViewMenu />
            <PageNav stripOpen={stripOpen} onToggleStrip={() => { setStripOpen((open) => !open); }} />
            <span className="top-bar-spacer" />
            <input
              type="range"
              className="zoom-slider"
              min={0.05}
              max={2}
              step={0.05}
              value={Math.min(2, Math.max(0.05, effectiveScale))}
              onChange={(e) => {
                setZoom(Number(e.target.value));
              }}
              title="Zoom"
            />
            <span className="zoom-value">
              {zoomPercent}
              %
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setZoom(null);
              }}
            >
              Fit
            </button>
          </div>
        </main>
        <div className="view-only-scope" inert={viewOnly}>
          <aside className="editor-right">
            <LayersPanel />
            <Inspector />
          </aside>
        </div>
      </div>
      {showExport && (
        <ExportDialog
          onClose={() => {
            setShowExport(false);
          }}
        />
      )}
      {showShortcuts && (
        <ShortcutsDialog
          onClose={() => {
            setShowShortcuts(false);
          }}
        />
      )}
      <ContextMenu />
      {leaveTarget !== null && (
        <LeaveLockedDialog
          onStay={() => { setLeaveTarget(null); }}
          onKeepAndLeave={() => {
            const target = leaveTarget;
            setLeaveTarget(null);
            leaveTo(target);
          }}
          onUnlockAndLeave={async () => {
            const target = leaveTarget;
            if (await useEditorStore.getState().unlock()) {
              setLeaveTarget(null);
              leaveTo(target);
            }
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

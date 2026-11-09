import { useCallback, useEffect, useState } from "react";
import { ASPECT_RATIOS, type DesignSummary, type Folder, PLATFORM_SIZES, type TemplateSummary } from "@mycanvas/shared";
import { api } from "../api";
import { Brand } from "../components/Brand";
import { FolderBar } from "../components/folders/FolderBar";
import { MoveToFolder } from "../components/folders/MoveToFolder";
import { TemplateGallery } from "../components/TemplateGallery";
import { ThemeToggle } from "../components/ThemeToggle";
import { UploadsManager } from "../components/uploads/UploadsManager";
import { UserBadge } from "../components/UserBadge";
import { ALL_DESIGNS, DESIGN_DRAG_MIME, type FolderView, folderViewHash, inView } from "../utils/folders";
import { relativeEditedTime } from "../utils/relative-time";

const MAX_CANVAS = 8192;
const CUSTOM_SIZE = "custom";

/** Canvas size for the selected preset id, or null when custom input is invalid. */
function resolveSize(sizeId: string, customWidth: string, customHeight: string) {
  if (sizeId === CUSTOM_SIZE) {
    const width = Number(customWidth);
    const height = Number(customHeight);
    const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= MAX_CANVAS;
    return valid(width) && valid(height) ? { width, height } : null;
  }
  const preset = [...ASPECT_RATIOS, ...PLATFORM_SIZES].find((entry) => entry.id === sizeId);
  return preset ? { width: preset.width, height: preset.height } : null;
}

function PresetGlyph({ width, height }: { width: number; height: number }) {
  const landscape = width >= height;
  const glyphWidth = landscape ? 32 : Math.max(8, Math.round((24 * width) / height));
  const glyphHeight = landscape ? Math.max(6, Math.round((32 * height) / width)) : 24;
  return (
    <span
      className="preset-glyph"
      style={{ width: glyphWidth, height: glyphHeight }}
      aria-hidden="true"
    />
  );
}

export function ProjectList({ view }: { view: FolderView }) {
  const [designs, setDesigns] = useState<DesignSummary[] | null>(null);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUploads, setShowUploads] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [presetId, setPresetId] = useState(ASPECT_RATIOS[0]?.id ?? "16:9");
  const [customWidth, setCustomWidth] = useState("1280");
  const [customHeight, setCustomHeight] = useState("720");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateBusyId, setTemplateBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const refresh = useCallback(() => {
    void api
      .listDesigns()
      .then(setDesigns)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load designs");
      });
  }, []);

  const refreshFolders = useCallback(() => {
    void api
      .listFolders()
      .then(setFolders)
      .catch(() => {
        setFolders([]);
      });
  }, []);

  const refreshTemplates = useCallback(() => {
    void api
      .listTemplates()
      .then(setTemplates)
      .catch(() => {
        setTemplates([]);
      });
  }, []);

  useEffect(() => {
    refresh();
    refreshFolders();
    refreshTemplates();
  }, [refresh, refreshFolders, refreshTemplates]);

  const currentFolder = view.kind === "folder" ? folders?.find((folder) => folder.id === view.id) : undefined;
  // A link to a folder that no longer exists falls back to all designs.
  useEffect(() => {
    if (view.kind === "folder" && folders !== null && !currentFolder) {
      window.location.hash = folderViewHash(ALL_DESIGNS);
    }
  }, [view, folders, currentFolder]);
  /** New designs land in the folder being viewed. */
  const targetFolderId = currentFolder?.id;

  const size = resolveSize(presetId, customWidth, customHeight);

  const create = async () => {
    if (!size) {
      return;
    }
    setCreating(true);
    try {
      const design = await api.createDesign({
        name: newName.trim() || "Untitled design",
        width: size.width,
        height: size.height,
        folderId: targetFolderId,
      });
      window.location.hash = `#/edit/${design.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create design");
      setCreating(false);
    }
  };

  const startFromTemplate = (template: TemplateSummary) => {
    if (templateBusyId) {
      return;
    }
    setTemplateBusyId(template.id);
    void api
      .createDesign({ templateId: template.id, folderId: targetFolderId })
      .then((design) => {
        window.location.hash = `#/edit/${design.id}`;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to create design from template");
        setTemplateBusyId(null);
      });
  };

  const removeTemplate = (template: TemplateSummary) => {
    if (!window.confirm(`Delete the template "${template.name}"? Designs made from it are kept.`)) {
      return;
    }
    void api
      .deleteTemplate(template.id)
      .then(refreshTemplates)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to delete template");
      });
  };

  const query = search.trim().toLowerCase();
  const designsInView = designs?.filter((design) => inView(view, design.folderId)) ?? [];
  const visibleDesigns = designsInView.filter((design) => design.name.toLowerCase().includes(query));
  const counts = new Map<string, number>([["all", designs?.length ?? 0], ["unfiled", 0]]);
  for (const design of designs ?? []) {
    const key = design.folderId ?? "unfiled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const viewTitle = view.kind === "unfiled"
    ? "Unfiled designs"
    : currentFolder
      ? currentFolder.name
      : "Continue designing";

  const move = (designId: string, folderId: string | null) => {
    // Optimistic: the card leaves this view right away.
    setDesigns((current) => current?.map((design) =>
      design.id === designId ? { ...design, folderId: folderId ?? undefined } : design) ?? null);
    void api
      .moveDesign(designId, folderId)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to move design");
      })
      .finally(refresh);
  };

  const createFolder = async (name: string) => {
    const folder = await api.createFolder(name);
    // Known before navigating, or the missing-folder fallback bounces back.
    setFolders((current) => [...(current ?? []), folder]);
    window.location.hash = folderViewHash({ kind: "folder", id: folder.id });
    refreshFolders();
  };

  const renameFolder = async (folder: Folder, name: string) => {
    await api.renameFolder(folder.id, name);
    refreshFolders();
  };

  const deleteFolder = (folder: Folder) => {
    const count = counts.get(folder.id) ?? 0;
    const detail = count === 0
      ? "It's empty."
      : `Its ${String(count)} ${count === 1 ? "design stays" : "designs stay"} and ${count === 1 ? "becomes" : "become"} unfiled.`;
    if (!window.confirm(`Delete the folder "${folder.name}"? ${detail}`)) {
      return;
    }
    void api
      .deleteFolder(folder.id)
      .then(() => {
        if (view.kind === "folder" && view.id === folder.id) {
          window.location.hash = folderViewHash(ALL_DESIGNS);
        }
        refreshFolders();
        refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to delete folder");
      });
  };

  const duplicate = (id: string) => {
    void api
      .duplicateDesign(id)
      .then(refresh)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to duplicate design");
      });
  };

  const remove = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) {
      return;
    }
    void api
      .deleteDesign(id)
      .then(refresh)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to delete design");
      });
  };

  return (
    <div className="list-screen">
      <header className="top-bar">
        <Brand />
        <div className="top-bar-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setShowUploads(true);
            }}
          >
            Uploads
          </button>
          <ThemeToggle />
          <UserBadge />
        </div>
      </header>

      <div className="list-hero">
        <h1>What will you design today?</h1>
        <button
          type="button"
          className="primary hero-cta"
          onClick={() => {
            setShowNew(true);
          }}
        >
          New design
        </button>
      </div>

      <div className="list-content">
        {error && <p className="form-error">{error}</p>}
        {templates.length > 0 && (
          <>
            <h2 className="section-title">Start from a template</h2>
            <TemplateGallery
              templates={templates}
              busyId={templateBusyId}
              onUse={startFromTemplate}
              onDelete={removeTemplate}
            />
          </>
        )}
        {designs === null && !error && <p className="muted">Loading…</p>}
        {designs !== null && folders !== null && (
          <FolderBar
            folders={folders}
            counts={counts}
            view={view}
            onCreate={createFolder}
            onRename={renameFolder}
            onDelete={deleteFolder}
            onDropDesign={move}
          />
        )}
        {designs !== null && (
          <div className="section-header">
            <h2 className="section-title">{viewTitle}</h2>
            {designsInView.length > 0 && (
              <input
                type="search"
                className="design-search"
                placeholder="Search designs"
                aria-label="Search designs"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
              />
            )}
          </div>
        )}
        {designs !== null && designs.length === 0 && (
          <p className="muted">No designs yet. Create your first one, or start from a template.</p>
        )}
        {designs !== null && designs.length > 0 && designsInView.length === 0 && (
          <p className="muted">
            {view.kind === "folder"
              ? "This folder is empty. Create a design here, or drag designs onto the folder."
              : "Nothing here."}
          </p>
        )}
        {designsInView.length > 0 && visibleDesigns.length === 0 && (
          <p className="muted">{`No designs match "${search.trim()}".`}</p>
        )}

        <div className="design-grid">
          {visibleDesigns.map((design) => (
            <div
              key={design.id}
              className="design-card"
              role="link"
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DESIGN_DRAG_MIME, design.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => {
                window.location.hash = `#/edit/${design.id}`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  window.location.hash = `#/edit/${design.id}`;
                }
              }}
            >
              <div className="design-thumb">
                {design.thumbnail
                  ? (
                      <img src={design.thumbnail} alt={design.name} />
                    )
                  : (
                      <span className="thumb-placeholder">
                        {`${String(design.width)} × ${String(design.height)}`}
                      </span>
                    )}
              </div>
              <div className="design-meta">
                <strong>{design.name}</strong>
                <span className="muted">
                  {`${String(design.width)} × ${String(design.height)} · ${relativeEditedTime(design.updatedAt)}`}
                </span>
              </div>
              <div className="design-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.location.hash = `#/edit/${design.id}`;
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicate(design.id);
                  }}
                >
                  Duplicate
                </button>
                {folders && (
                  <MoveToFolder
                    folders={folders}
                    currentFolderId={design.folderId}
                    onMove={(folderId) => { move(design.id, folderId); }}
                  />
                )}
                <button
                  type="button"
                  className="secondary danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(design.id, design.name);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showNew && (
        <div
          className="dialog-backdrop"
          onClick={() => {
            setShowNew(false);
          }}
        >
          <div
            className="dialog dialog-new-design"
            role="dialog"
            aria-label="New design"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <h2>New design</h2>
            <label className="field field-wide">
              <span>Name</span>
              <input
                type="text"
                value={newName}
                placeholder="Untitled design"
                autoFocus
                onChange={(e) => {
                  setNewName(e.target.value);
                }}
              />
            </label>
            <div className="field field-wide">
              <span>Aspect ratio</span>
              <div className="preset-grid">
                {ASPECT_RATIOS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={preset.id === presetId ? "preset selected" : "preset"}
                    onClick={() => {
                      setPresetId(preset.id);
                    }}
                  >
                    <PresetGlyph width={preset.width} height={preset.height} />
                    <strong>{preset.label}</strong>
                    <span className="muted">{`${String(preset.width)} × ${String(preset.height)}`}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="field field-wide">
              <span>Platforms</span>
              <div className="platform-list">
                {PLATFORM_SIZES.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={preset.id === presetId ? "platform-size selected" : "platform-size"}
                    onClick={() => {
                      setPresetId(preset.id);
                    }}
                  >
                    <PresetGlyph width={preset.width} height={preset.height} />
                    <strong>{preset.label}</strong>
                    <span className="muted">{`${String(preset.width)} × ${String(preset.height)}`}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="field field-wide">
              <span>Custom size (px)</span>
              <div
                className={presetId === CUSTOM_SIZE ? "custom-size selected" : "custom-size"}
                onFocus={() => {
                  setPresetId(CUSTOM_SIZE);
                }}
              >
                <input
                  type="number"
                  min={1}
                  max={MAX_CANVAS}
                  aria-label="Custom width"
                  value={customWidth}
                  onChange={(e) => {
                    setCustomWidth(e.target.value);
                  }}
                />
                <span className="muted" aria-hidden="true">×</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_CANVAS}
                  aria-label="Custom height"
                  value={customHeight}
                  onChange={(e) => {
                    setCustomHeight(e.target.value);
                  }}
                />
              </div>
              {presetId === CUSTOM_SIZE && !size && (
                <p className="form-error">{`Width and height must be whole numbers from 1 to ${String(MAX_CANVAS)}.`}</p>
              )}
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowNew(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={creating || !size}
                onClick={() => {
                  void create();
                }}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showUploads && (
        <UploadsManager
          onClose={() => {
            setShowUploads(false);
            // Deleting an image changes design previews only on next save.
            void api.listDesigns().then(setDesigns).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

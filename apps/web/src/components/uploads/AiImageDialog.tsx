import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AiConnection,
  type AiCredits,
  type AiModelInfo,
  PIXEL_SIZES,
  imageOptionsFor,
  isAccountKind,
  ratioSize,
} from "@mycanvas/shared";
import { api } from "../../api";
import { useEditorStore } from "../../store/editorStore";
import { aiImageBlob, cachedAiSettings, listAiModels, uploadGenerated } from "../../utils/ai-client";

/*
 * Make an image with any connected image model: pick the service and model,
 * describe it, choose its shape, size and background, look at the result,
 * try again, then put the one you like on the page. Only pictures you use
 * go to Uploads.
 */

interface Attempt {
  id: number;
  blob: Blob;
  url: string;
  prompt: string;
  /** "Runway · nano-banana-2.1 · 16:9 · 2K" */
  made: string;
}

interface Remembered {
  connectionId?: string;
  model?: string;
  ratio?: string;
  size?: string;
  transparent?: boolean;
}

const MEMORY_KEY = "mycanvas-ai-image-maker";

function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

function remember(value: Remembered) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: start from defaults next time.
  }
}

const RATIO_NAMES: Record<string, string> = {
  "1:1": "Square",
  "4:5": "Portrait",
  "3:4": "Portrait",
  "2:3": "Portrait",
  "9:16": "Tall",
  "5:4": "Landscape",
  "4:3": "Landscape",
  "3:2": "Landscape",
  "16:9": "Wide",
  "21:9": "Panorama",
};

function ratioLabel(ratio: string): string {
  const name = RATIO_NAMES[ratio];
  return name ? `${ratio} · ${name}` : ratio;
}

function sizeLabel(size: string): string {
  return /^\d+(\.\d+)?k$/.test(size) ? size.toUpperCase() : size;
}

/** The listed ratio closest to width:height. */
function closestRatio(ratios: string[], width: number, height: number): string | undefined {
  const wanted = Math.log(width / height);
  let best: string | undefined;
  let distance = Infinity;
  for (const ratio of ratios) {
    const [w = 1, h = 1] = ratio.split(":").map(Number);
    const d = Math.abs(Math.log(w / h) - wanted);
    if (d < distance) {
      best = ratio;
      distance = d;
    }
  }
  return best;
}

/** Connections that can make pictures: all but plain text servers, unless one is the Images choice. */
function canMakeImages(connection: AiConnection, imageConnectionId: string | undefined): boolean {
  return connection.kind !== "openai" || connection.id === imageConnectionId;
}

function creditText(credits: AiCredits | null): string {
  if (!credits) {
    return "";
  }
  const amount = credits.credits === null ? "Unlimited" : `${credits.credits.toLocaleString()} credits`;
  return credits.plan ? `${amount} · ${credits.plan}` : amount;
}

export function AiImageDialog({ onClose, onPlace }: { onClose: () => void; onPlace: (asset: string, as: "layer" | "background") => void }) {
  const design = useEditorStore((state) => state.design);
  const bumpAssetsVersion = useEditorStore((state) => state.bumpAssetsVersion);
  const [connections, setConnections] = useState<AiConnection[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [models, setModels] = useState<AiModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("");
  const [size, setSize] = useState("");
  const [transparent, setTransparent] = useState(() => remembered().transparent === true);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [credits, setCredits] = useState<AiCredits | null>(null);
  const closed = useRef(false);
  const urls = useRef<string[]>([]);
  const nextId = useRef(1);

  const connection = connections?.find((entry) => entry.id === connectionId);
  const imageModels = useMemo(() => (models ?? []).filter((entry) => !entry.kinds || entry.kinds.includes("image")), [models]);
  const modelInfo = imageModels.find((entry) => entry.id === model);
  const options = connection ? imageOptionsFor(connection.kind, modelInfo) : null;
  const busy = status !== null;
  const current = attempts.find((attempt) => attempt.id === shown) ?? attempts.at(-1);

  // Connections and the starting choice: last used here, else the Images choice in AI settings.
  useEffect(() => {
    closed.current = false;
    void cachedAiSettings()
      .then((settings) => {
        const usable = settings.connections.filter((entry) => canMakeImages(entry, settings.image?.connectionId));
        setConnections(usable);
        const memory = remembered();
        const start = usable.find((entry) => entry.id === memory.connectionId) ?? usable.find((entry) => entry.id === settings.image?.connectionId) ?? usable[0];
        if (start) {
          setConnectionId(start.id);
          setModel(start.id === memory.connectionId ? memory.model ?? "" : start.id === settings.image?.connectionId ? settings.image.model : "");
        }
      })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : "Couldn't load AI settings."); });
    return () => {
      closed.current = true;
      for (const url of urls.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  // The connection's models (and credits for account services).
  useEffect(() => {
    if (!connection) {
      return;
    }
    let cancelled = false;
    setModels(null);
    setModelsError(null);
    setCredits(null);
    void listAiModels(connection)
      .then((list) => {
        if (cancelled) {
          return;
        }
        setModels(list);
        const images = list.filter((entry) => !entry.kinds || entry.kinds.includes("image"));
        setModel((wanted) => (images.some((entry) => entry.id === wanted) ? wanted : images[0]?.id ?? ""));
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setModelsError(reason instanceof Error ? reason.message : "Couldn't list the models.");
        }
      });
    if (isAccountKind(connection.kind)) {
      void api.aiCredits(connection.id).then((answer) => { if (!cancelled) { setCredits(answer); } }).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // Keep the ratio and size valid for the model: last used, else the page's shape and the model's default.
  useEffect(() => {
    if (!options) {
      return;
    }
    const memory = remembered();
    setRatio((wanted) => {
      if (options.ratios.includes(wanted)) {
        return wanted;
      }
      if (memory.ratio && options.ratios.includes(memory.ratio)) {
        return memory.ratio;
      }
      return closestRatio(options.ratios, design?.width ?? 1, design?.height ?? 1) ?? options.ratios[0] ?? "1:1";
    });
    setSize((wanted) => {
      if (options.sizes.includes(wanted)) {
        return wanted;
      }
      if (memory.size && options.sizes.includes(memory.size)) {
        return memory.size;
      }
      return options.defaultSize ?? options.sizes[0] ?? "";
    });
    // Options are rebuilt each render; their content changes only with the model.
  }, [connectionId, model, models]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onClose]);

  const make = async () => {
    const wanted = prompt.trim();
    if (!connection || !options || !wanted || busy) {
      return;
    }
    if (!model && imageModels.length > 0) {
      return;
    }
    remember({ connectionId: connection.id, model, ratio, size, transparent });
    setError(null);
    setStatus(`Making the picture with ${connection.name}…`);
    const native = transparent && options.transparent === true;
    const cutLater = transparent && !native;
    const pixels = PIXEL_SIZES[size] ?? 1024;
    const { width, height } = ratioSize(ratio || "1:1", pixels);
    try {
      let blob = await aiImageBlob({
        // A plain backdrop makes the cut-out cleaner.
        prompt: cutLater ? `${wanted.replace(/\.$/, "")}. Isolated subject on a plain, evenly lit, light background.` : wanted,
        width,
        height,
        name: wanted.slice(0, 60),
        choice: { connection, model },
        ratio: ratio || undefined,
        size: size || undefined,
        transparent: native,
      });
      if (cutLater && !closed.current) {
        setStatus("Removing the background…");
        const { cutoutPicture } = await import("../../utils/bg-removal");
        blob = await cutoutPicture(blob, (progress) => {
          if (!closed.current) {
            setStatus(progress === null ? "Removing the background…" : `Getting the background remover… ${String(Math.round(progress * 100))}%`);
          }
        });
      }
      if (closed.current) {
        return;
      }
      const url = URL.createObjectURL(blob);
      urls.current.push(url);
      const id = nextId.current;
      nextId.current += 1;
      const made = [connection.name, modelInfo?.label ?? model, ratio, size && sizeLabel(size), transparent ? "transparent" : ""].filter(Boolean).join(" · ");
      setAttempts((list) => [...list, { id, blob, url, prompt: wanted, made }]);
      setShown(id);
      if (isAccountKind(connection.kind)) {
        void api.aiCredits(connection.id).then((answer) => { if (!closed.current) { setCredits(answer); } }).catch(() => undefined);
      }
    } catch (reason) {
      if (!closed.current) {
        setError(reason instanceof Error ? reason.message : "The image model failed.");
      }
    } finally {
      if (!closed.current) {
        setStatus(null);
      }
    }
  };

  const use = async (as: "layer" | "background") => {
    if (!current || placing) {
      return;
    }
    setPlacing(true);
    setError(null);
    try {
      const asset = await uploadGenerated(current.blob, current.prompt);
      bumpAssetsVersion();
      onPlace(asset, as);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't add the picture to Uploads.");
      setPlacing(false);
    }
  };

  const nativeTransparent = options?.transparent === true;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
      <div className="dialog ai-image-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-image-title">
        <h2 id="ai-image-title">Make an image with AI</h2>
        {connections?.length === 0 && (
          <p className="muted">No image model is connected yet. Add one in AI settings (Kling, Runway, PixVerse, Gemini or ComfyUI).</p>
        )}
        {connections && connections.length > 0 && (
          <div className="ai-image-body">
            <form
              className="ai-image-controls"
              onSubmit={(e) => {
                e.preventDefault();
                void make();
              }}
            >
              <label className="field">
                <span>Service</span>
                <select value={connectionId} disabled={busy} onChange={(e) => { setConnectionId(e.target.value); setModel(""); }}>
                  {connections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>
                  Model
                  {credits && <em>{creditText(credits)}</em>}
                </span>
                <select value={model} disabled={busy || !models || imageModels.length === 0} onChange={(e) => { setModel(e.target.value); }}>
                  {!models && !modelsError && <option value={model}>(loading models…)</option>}
                  {models && imageModels.length === 0 && <option value="">No image models here</option>}
                  {modelsError && !models && <option value={model}>{model || "Couldn't list models"}</option>}
                  {imageModels.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id}</option>
                  ))}
                </select>
              </label>
              {modelsError && <p className="form-error">{modelsError}</p>}
              <label className="field">
                <span>Describe the image</span>
                <textarea
                  rows={5}
                  value={prompt}
                  maxLength={4000}
                  placeholder="A watercolor fox reading a newspaper in a sunny kitchen"
                  disabled={busy}
                  onChange={(e) => { setPrompt(e.target.value); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void make();
                    }
                  }}
                />
              </label>
              <div className="ai-image-row">
                <label className="field">
                  <span>Shape</span>
                  <select value={ratio} disabled={busy || !options} onChange={(e) => { setRatio(e.target.value); }}>
                    {(options?.ratios ?? []).map((entry) => <option key={entry} value={entry}>{ratioLabel(entry)}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Size</span>
                  <select value={size} disabled={busy || !options || options.sizes.length === 0} onChange={(e) => { setSize(e.target.value); }}>
                    {options?.sizes.length === 0 && <option value="">Model&apos;s own</option>}
                    {(options?.sizes ?? []).map((entry) => <option key={entry} value={entry}>{sizeLabel(entry)}</option>)}
                  </select>
                </label>
              </div>
              <label className="ai-image-check">
                <input type="checkbox" checked={transparent} disabled={busy} onChange={(e) => { setTransparent(e.target.checked); }} />
                <span>
                  Transparent background
                  <small className="muted">
                    {nativeTransparent ? "This model makes it itself." : "The background is removed on this computer after the picture arrives."}
                  </small>
                </span>
              </label>
              {error && <p className="form-error">{error}</p>}
              <button type="submit" className="primary block" disabled={busy || !prompt.trim() || !options || (!model && imageModels.length > 0)}>
                {busy ? "Working…" : attempts.length > 0 ? "Make another" : "Make image"}
              </button>
              {connection && isAccountKind(connection.kind) && <p className="muted ai-image-note">{`Each picture uses ${connection.name} credits.`}</p>}
            </form>
            <div className="ai-image-result">
              <div className={current ? "ai-image-preview has-image" : "ai-image-preview"}>
                {current && <img src={current.url} alt={current.prompt} />}
                {!current && !busy && <p className="muted">Your image shows up here.</p>}
                {busy && <p className="ai-image-status">{status}</p>}
              </div>
              {current && <p className="muted ai-image-made">{current.made}</p>}
              {attempts.length > 1 && (
                <div className="ai-image-attempts" role="listbox" aria-label="Earlier attempts">
                  {attempts.map((attempt) => (
                    <button
                      key={attempt.id}
                      type="button"
                      role="option"
                      aria-selected={attempt.id === current?.id}
                      className={attempt.id === current?.id ? "active" : ""}
                      title={attempt.prompt}
                      onClick={() => { setShown(attempt.id); }}
                    >
                      <img src={attempt.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
          <button type="button" className="secondary" disabled={!current || placing || busy} onClick={() => { void use("background"); }}>Set as background</button>
          <button type="button" className="primary" disabled={!current || placing || busy} onClick={() => { void use("layer"); }}>
            {placing ? "Adding…" : "Add to page"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  AI_CONNECTION_KINDS,
  type AiAssignment,
  type AiConnectionInput,
  type AiConnectionKind,
  type AiModelInfo,
  type AiSettings,
  type ComfyWorkflow,
  DEFAULT_FLUX_KLEIN,
} from "@mycanvas/shared";
import { api } from "../../api";
import { AdminAiSection } from "./AdminAiSection";
import { browserKey, invalidateAiSettings, listAiModels, setBrowserKey } from "../../utils/ai-client";

/** Draft of the settings being edited (connections may carry a new key). */
interface Draft {
  connections: AiConnectionInput[];
  text: AiAssignment | null;
  image: AiAssignment | null;
}

type ModelState = { state: "loading" } | { state: "ok"; models: AiModelInfo[] } | { state: "error"; message: string };

const ADDRESS_PLACEHOLDER: Record<AiConnectionKind, string> = {
  gemini: "",
  openai: "http://192.168.0.37:11439/v1",
  comfyui: "https://192.168.0.37:8192",
};

function toDraft(settings: AiSettings): Draft {
  return { connections: settings.connections.map((connection) => ({ ...connection })), text: settings.text, image: settings.image };
}

function newId(): string {
  return `c-${crypto.randomUUID().slice(0, 8)}`;
}

function kindLabel(kind: AiConnectionKind): string {
  return AI_CONNECTION_KINDS.find((entry) => entry.id === kind)?.label ?? kind;
}

/** One connection's editable fields. */
function ConnectionEditor({
  connection,
  onChange,
  onRemove,
  onTest,
  test,
  isOwner,
}: {
  isOwner: boolean;
  connection: AiConnectionInput;
  onChange: (next: AiConnectionInput) => void;
  onRemove: () => void;
  onTest: () => void;
  test: ModelState | undefined;
}) {
  const workflow: ComfyWorkflow = connection.workflow ?? DEFAULT_FLUX_KLEIN;
  const browser = connection.runsIn === "browser";
  const localKey = browser ? browserKey(connection.id) : null;
  const hasKey = browser ? Boolean(localKey) : connection.hasKey === true;
  const keyHint = browser ? (localKey ?? "").slice(-4) : connection.keyHint ?? "····";
  const keyLabel = connection.kind === "gemini" ? "API key" : "API key (if the server needs one)";
  if (connection.house) {
    return (
      <div className="ai-connection ai-connection-house">
        <div className="ai-connection-head">
          <span className="ai-kind-tag">{kindLabel(connection.kind)}</span>
          <strong className="ai-connection-name">{connection.name}</strong>
          <button type="button" className="secondary" onClick={onTest} title="Check the connection and list its models">Test</button>
        </div>
        <p className="muted ai-role-hint">Shared by the owner. Choose it above for text or images; its details stay private.</p>
        {test && (
          <p className={test.state === "error" ? "form-error ai-test" : "muted ai-test"} role="status">
            {test.state === "loading" ? "Checking…" : test.state === "error" ? test.message : `Connected · ${String(test.models.length)} ${test.models.length === 1 ? "model" : "models"} found`}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="ai-connection">
      <div className="ai-connection-head">
        <span className="ai-kind-tag">{kindLabel(connection.kind)}</span>
        <input
          className="ai-connection-name"
          value={connection.name}
          maxLength={80}
          aria-label="Connection name"
          onChange={(e) => { onChange({ ...connection, name: e.target.value }); }}
        />
        <button type="button" className="secondary" onClick={onTest} title="Save, then check the connection and list its models">
          Test
        </button>
        <button type="button" className="secondary danger" onClick={onRemove}>Remove</button>
      </div>
      {connection.kind !== "gemini" && (
        <div className="ai-runs-in">
          <div className="segmented" role="radiogroup" aria-label="Runs on">
            <button
              type="button"
              role="radio"
              aria-checked={!browser}
              className={browser ? "" : "active"}
              onClick={() => { onChange({ ...connection, runsIn: "server" }); }}
            >
              MyCanvas server
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={browser}
              className={browser ? "active" : ""}
              onClick={() => { onChange({ ...connection, runsIn: "browser", allowSelfSigned: false }); }}
            >
              This computer
            </button>
          </div>
          <span className="muted ai-runs-in-hint">
            {browser
              ? connection.kind === "comfyui"
                ? "Your browser talks to ComfyUI on your computer. Use http://localhost:8188 and start ComfyUI with --enable-cors-header."
                : `Your browser talks to the tool on your computer. Use http://localhost:… (Ollama: http://localhost:11434/v1, started with OLLAMA_ORIGINS=${window.location.origin}; LM Studio: turn on "Enable CORS").`
              : "The MyCanvas server makes the calls: cloud services and machines on the server's own network."}
          </span>
        </div>
      )}
      {connection.kind !== "gemini" && (
        <label className="field field-wide">
          <span>Address</span>
          <input
            value={connection.baseUrl ?? ""}
            placeholder={ADDRESS_PLACEHOLDER[connection.kind]}
            spellCheck={false}
            onChange={(e) => { onChange({ ...connection, baseUrl: e.target.value }); }}
          />
        </label>
      )}
      {connection.kind !== "comfyui" && (
        <label className="field field-wide">
          <span>{keyLabel}</span>
          <span className="ai-key-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={typeof connection.apiKey === "string" ? connection.apiKey : ""}
              placeholder={connection.apiKey === null
                ? "Will be removed when you save"
                : hasKey
                  ? `${browser ? "Stored in this browser" : "Stored"} (ends in ${keyHint}). Type to replace.`
                  : browser ? "Paste the key (kept in this browser only)" : "Paste the key"}
              onChange={(e) => { onChange({ ...connection, apiKey: e.target.value }); }}
            />
            {hasKey && connection.apiKey !== null && (
              <button type="button" className="secondary" onClick={() => { onChange({ ...connection, apiKey: null }); }}>
                Remove key
              </button>
            )}
          </span>
        </label>
      )}
      {connection.kind !== "gemini" && !browser && (
        <label className="ai-check">
          <input
            type="checkbox"
            checked={connection.allowSelfSigned === true}
            onChange={(e) => { onChange({ ...connection, allowSelfSigned: e.target.checked }); }}
          />
          Accept a self-signed certificate (your own server on the local network)
        </label>
      )}
      {isOwner && connection.kind !== "gemini" && !browser && (
        <label className="ai-check">
          <input
            type="checkbox"
            checked={connection.shared === true}
            onChange={(e) => { onChange({ ...connection, shared: e.target.checked }); }}
          />
          Share with the accounts you allow below (they see its name only)
        </label>
      )}
      {connection.kind === "comfyui" && (
        <div className="ai-workflow">
          <div className="segmented" role="radiogroup" aria-label="Workflow">
            <button
              type="button"
              role="radio"
              aria-checked={workflow.preset === "flux2-klein"}
              className={workflow.preset === "flux2-klein" ? "active" : ""}
              onClick={() => { onChange({ ...connection, workflow: DEFAULT_FLUX_KLEIN }); }}
            >
              FLUX.2 klein
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={workflow.preset === "custom"}
              className={workflow.preset === "custom" ? "active" : ""}
              onClick={() => { onChange({ ...connection, workflow: { preset: "custom", workflow: "" } }); }}
            >
              My workflow
            </button>
          </div>
          {workflow.preset === "flux2-klein"
            ? (
                <div className="ai-grid">
                  {(["unet", "textEncoder", "vae"] as const).map((field) => (
                    <label key={field} className="field">
                      <span>{field === "unet" ? "Model file" : field === "textEncoder" ? "Text encoder" : "VAE"}</span>
                      <input
                        value={workflow[field]}
                        spellCheck={false}
                        list={field === "unet" ? `comfy-models-${connection.id}` : undefined}
                        onChange={(e) => { onChange({ ...connection, workflow: { ...workflow, [field]: e.target.value } }); }}
                      />
                    </label>
                  ))}
                  <label className="field">
                    <span>Steps</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={workflow.steps}
                      onChange={(e) => { onChange({ ...connection, workflow: { ...workflow, steps: Number(e.target.value) } }); }}
                    />
                  </label>
                  {test?.state === "ok" && (
                    <datalist id={`comfy-models-${connection.id}`}>
                      {test.models.map((model) => <option key={model.id} value={model.id} />)}
                    </datalist>
                  )}
                </div>
              )
            : (
                <label className="field field-wide">
                  <span>
                    Workflow (ComfyUI → Workflow → Export (API)) with
                    {"{{prompt}}"}
                    , and optionally
                    {"{{width}}"}
                    ,
                    {"{{height}}"}
                    ,
                    {"{{seed}}"}
                  </span>
                  <textarea
                    rows={6}
                    spellCheck={false}
                    value={workflow.workflow}
                    onChange={(e) => { onChange({ ...connection, workflow: { preset: "custom", workflow: e.target.value } }); }}
                  />
                </label>
              )}
        </div>
      )}
      {test && (
        <p className={test.state === "error" ? "form-error ai-test" : "muted ai-test"} role="status">
          {test.state === "loading"
            ? "Checking…"
            : test.state === "error"
              ? test.message
              : `Connected · ${String(test.models.length)} ${test.models.length === 1 ? "model" : "models"} found`}
        </p>
      )}
    </div>
  );
}

/** Which connection and model does one job (text or images). */
function RolePicker({
  role,
  draft,
  models,
  onChange,
  onLoadModels,
}: {
  role: "text" | "image";
  draft: Draft;
  models: Record<string, ModelState>;
  onChange: (value: AiAssignment | null) => void;
  onLoadModels: (connectionId: string) => void;
}) {
  const value = draft[role];
  const candidates = draft.connections.filter((connection) => role === "image" || connection.kind !== "comfyui");
  const connection = draft.connections.find((entry) => entry.id === value?.connectionId);
  const state = value ? models[value.connectionId] : undefined;
  const listed = state?.state === "ok" ? state.models.filter((model) => !model.kinds || model.kinds.includes(role)) : [];
  const others = state?.state === "ok" ? state.models.filter((model) => model.kinds && !model.kinds.includes(role)) : [];

  return (
    <section className="ai-role">
      <h3>{role === "text" ? "Text" : "Images"}</h3>
      <p className="muted ai-role-hint">
        {role === "text"
          ? "Tidies imported content, tags callouts, writes image prompts."
          : "Makes illustrations in your formats' style. They go to your Uploads."}
      </p>
      <label className="field field-wide">
        <span>Connection</span>
        <select
          value={value?.connectionId ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) {
              onChange(null);
              return;
            }
            onChange({ connectionId: id, model: "" });
            onLoadModels(id);
          }}
        >
          <option value="">Off</option>
          {candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      {value && connection && connection.kind !== "comfyui" && (
        <label className="field field-wide">
          <span>
            Model
            {state?.state === "loading" && <em>loading…</em>}
          </span>
          <input
            value={value.model}
            spellCheck={false}
            list={`ai-models-${role}`}
            placeholder={connection.kind === "gemini" ? (role === "text" ? "gemini-2.5-flash" : "gemini-2.5-flash-image") : "Model id"}
            onFocus={() => {
              if (!state) {
                onLoadModels(connection.id);
              }
            }}
            onChange={(e) => { onChange({ ...value, model: e.target.value }); }}
          />
          <datalist id={`ai-models-${role}`}>
            {[...listed, ...others].map((model) => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}
          </datalist>
        </label>
      )}
      {value && connection?.kind === "comfyui" && <p className="muted ai-role-hint">The workflow in this connection decides the model.</p>}
      {state?.state === "error" && <p className="form-error ai-test">{state.message}</p>}
    </section>
  );
}

/**
 * AI setup for this account: connections (keys are stored encrypted on the
 * server and never sent back) and which one does text and which images.
 */
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<Record<string, ModelState>>({});
  const [adding, setAdding] = useState(false);
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    void api.me().then((me) => { setIsOwner(me.isOwner === true); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void api.aiSettings().then((settings) => { setDraft(toDraft(settings)); }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Couldn't load AI settings");
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const save = async (current: Draft): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      // Keys of "this computer" connections stay in this browser, never on the server.
      for (const connection of current.connections) {
        if (connection.runsIn === "browser" && connection.apiKey !== undefined) {
          setBrowserKey(connection.id, connection.apiKey?.trim() ? connection.apiKey.trim() : null);
        }
      }
      const result = await api.saveAiSettings({
        ...current,
        connections: current.connections.map((connection) => {
          if (connection.runsIn !== "browser") {
            return connection;
          }
          const { apiKey: _apiKey, ...rest } = connection;
          return rest;
        }),
      });
      invalidateAiSettings();
      setDraft(toDraft(result));
      setSaved(true);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't save");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const loadModels = (connectionId: string) => {
    const connection = draft?.connections.find((entry) => entry.id === connectionId);
    if (!connection) {
      return;
    }
    setModels((current) => ({ ...current, [connectionId]: { state: "loading" } }));
    listAiModels(connection)
      .then((list) => { setModels((current) => ({ ...current, [connectionId]: { state: "ok", models: list } })); })
      .catch((reason: unknown) => {
        setModels((current) => ({ ...current, [connectionId]: { state: "error", message: reason instanceof Error ? reason.message : "Couldn't connect" } }));
      });
  };

  const update = (next: Draft) => {
    setDraft(next);
    setSaved(false);
  };

  if (!draft) {
    return (
      <div className="dialog-backdrop" role="presentation">
        <div className="dialog ai-dialog" role="dialog" aria-modal="true">
          <h2>AI settings</h2>
          {error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>}
          <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const addConnection = (kind: AiConnectionKind) => {
    const connection: AiConnectionInput = {
      id: newId(),
      kind,
      name: kind === "gemini" ? "Google Gemini" : kind === "comfyui" ? "ComfyUI" : "Local LLM",
      ...(kind === "comfyui" ? { workflow: DEFAULT_FLUX_KLEIN } : {}),
    };
    update({ ...draft, connections: [...draft.connections, connection] });
    setAdding(false);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) { onClose(); } }}>
      <div className="dialog ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <h2 id="ai-settings-title">AI settings</h2>
        <p className="muted ai-intro">
          Mix and match: text and images can come from different places, local or cloud. Keys are stored encrypted on the server for your account only; they&apos;re never shown again or sent to the browser.
        </p>
        <div className="ai-roles">
          <RolePicker role="text" draft={draft} models={models} onChange={(text) => { update({ ...draft, text }); }} onLoadModels={loadModels} />
          <RolePicker role="image" draft={draft} models={models} onChange={(image) => { update({ ...draft, image }); }} onLoadModels={loadModels} />
        </div>

        <h3 className="ai-section-title">Connections</h3>
        {draft.connections.length === 0 && <p className="muted">No connections yet. Add one to start.</p>}
        {draft.connections.map((connection, index) => (
          <ConnectionEditor
            key={connection.id}
            isOwner={isOwner}
            connection={connection}
            test={models[connection.id]}
            onChange={(next) => {
              const connections = [...draft.connections];
              connections[index] = next;
              update({ ...draft, connections });
            }}
            onRemove={() => {
              update({
                connections: draft.connections.filter((entry) => entry.id !== connection.id),
                text: draft.text?.connectionId === connection.id ? null : draft.text,
                image: draft.image?.connectionId === connection.id ? null : draft.image,
              });
            }}
            onTest={() => {
              void save(draft).then((ok) => {
                if (ok) {
                  loadModels(connection.id);
                }
              });
            }}
          />
        ))}
        {adding
          ? (
              <div className="ai-add">
                {AI_CONNECTION_KINDS.map((kind) => (
                  <button key={kind.id} type="button" className="ai-add-option" onClick={() => { addConnection(kind.id); }}>
                    <strong>{kind.label}</strong>
                    <span className="muted">{kind.hint}</span>
                  </button>
                ))}
              </div>
            )
          : (
              <button type="button" className="secondary" onClick={() => { setAdding(true); }}>+ Add connection</button>
            )}

        <AdminAiSection />
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          {saved && <span className="muted ai-saved">Saved</span>}
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>Close</button>
          <button type="button" className="primary" disabled={saving} onClick={() => { void save(draft); }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

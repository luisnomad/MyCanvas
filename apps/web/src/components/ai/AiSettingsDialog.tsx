import { useEffect, useRef, useState } from "react";
import {
  AI_CONNECTION_KINDS,
  type AiAssignment,
  type AiConnectionInput,
  type AiConnectionKind,
  type AiCredits,
  type AiModelInfo,
  type AiSettings,
  type ComfyWorkflow,
  DEFAULT_FLUX3_KLEIN,
  DEFAULT_FLUX_KLEIN,
  connectionKindInfo,
  isAccountKind,
  isImagesOnlyKind,
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

/** An account login in progress (Kling, Runway, PixVerse). */
type LoginState = { state: "starting" } | { state: "waiting"; url: string; code?: string } | { state: "done" } | { state: "error"; message: string };

type CreditState = { state: "loading" } | ({ state: "ok" } & AiCredits) | { state: "error"; message: string };

const ADDRESS_PLACEHOLDER: Partial<Record<AiConnectionKind, string>> = {
  openai: "http://192.168.0.37:11439/v1",
  comfyui: "https://192.168.0.37:8192",
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

function creditLine(credits: CreditState | undefined): string | null {
  if (!credits) {
    return null;
  }
  if (credits.state === "loading") {
    return "Checking credits…";
  }
  if (credits.state === "error") {
    return credits.message;
  }
  const amount = credits.credits === null ? "Credits: not reported" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(credits.credits)} credits left`;
  return credits.plan ? `${amount} · ${credits.plan}` : amount;
}

/** Log in / log out for a connection that uses the owner's account instead of a key. */
function AccountLogin({
  connection,
  login,
  credits,
  onLogin,
  onChange,
}: {
  connection: AiConnectionInput;
  login: LoginState | undefined;
  credits: CreditState | undefined;
  onLogin: () => void;
  onChange: (next: AiConnectionInput) => void;
}) {
  const loggedIn = connection.hasKey === true && connection.apiKey !== null;
  const expiresAt = connection.account?.expiresAt ? new Date(connection.account.expiresAt) : null;
  const expired = expiresAt !== null && expiresAt.getTime() < Date.now();
  const busy = login?.state === "starting" || login?.state === "waiting";
  let status = "Not logged in";
  if (connection.apiKey === null) {
    status = "Logs out when you save";
  } else if (loggedIn) {
    status = expired
      ? "The login ran out. Log in again."
      : `Logged in${connection.account ? ` since ${dateFormat.format(new Date(connection.account.connectedAt))}` : ""}${expiresAt ? `, until ${dateFormat.format(expiresAt)}` : ""}`;
  }
  const line = loggedIn && !expired ? creditLine(credits) : null;
  return (
    <div className="ai-account">
      <div className="ai-account-row">
        <span className={expired ? "form-error" : "muted"}>{status}</span>
        <button type="button" className={loggedIn && !expired ? "secondary" : "primary"} disabled={busy} onClick={onLogin}>
          {busy ? "Waiting…" : loggedIn ? "Log in again" : "Log in"}
        </button>
        {loggedIn && (
          <button type="button" className="secondary" onClick={() => { onChange({ ...connection, apiKey: null }); }}>Log out</button>
        )}
        {connection.apiKey === null && (
          <button type="button" className="secondary" onClick={() => { onChange({ ...connection, apiKey: undefined }); }}>Keep logged in</button>
        )}
      </div>
      {login?.state === "starting" && <p className="muted ai-test" role="status">Opening the login page…</p>}
      {login?.state === "waiting" && (
        <p className="muted ai-test" role="status">
          {`Approve MyCanvas in the ${connectionKindInfo(connection.kind)?.label ?? connection.name} tab`}
          {login.code ? ` (code ${login.code.slice(0, 8)}…)` : ""}
          {". "}
          <a href={login.url} target="_blank" rel="noopener noreferrer">Open it again</a>
        </p>
      )}
      {login?.state === "error" && <p className="form-error ai-test" role="status">{login.message}</p>}
      {line && <p className={credits?.state === "error" ? "form-error ai-test" : "muted ai-test"} role="status">{line}</p>}
    </div>
  );
}

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
  login,
  credits,
  onLogin,
}: {
  isOwner: boolean;
  connection: AiConnectionInput;
  onChange: (next: AiConnectionInput) => void;
  onRemove: () => void;
  onTest: () => void;
  test: ModelState | undefined;
  login: LoginState | undefined;
  credits: CreditState | undefined;
  onLogin: () => void;
}) {
  const account = isAccountKind(connection.kind);
  const workflow: ComfyWorkflow = connection.workflow ?? DEFAULT_FLUX3_KLEIN;
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
      {account && <AccountLogin connection={connection} login={login} credits={credits} onLogin={onLogin} onChange={onChange} />}
      {connection.kind !== "gemini" && !account && (
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
      {connection.kind !== "gemini" && !account && (
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
      {connection.kind !== "comfyui" && !account && (
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
      {connection.kind !== "gemini" && !account && !browser && (
        <label className="ai-check">
          <input
            type="checkbox"
            checked={connection.allowSelfSigned === true}
            onChange={(e) => { onChange({ ...connection, allowSelfSigned: e.target.checked }); }}
          />
          Accept a self-signed certificate (your own server on the local network)
        </label>
      )}
      {isOwner && connection.kind !== "gemini" && !account && !browser && (
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
              aria-checked={workflow.preset === "flux3-klein"}
              className={workflow.preset === "flux3-klein" ? "active" : ""}
              onClick={() => { onChange({ ...connection, workflow: DEFAULT_FLUX3_KLEIN }); }}
            >
              FLUX 3 klein
            </button>
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
          {workflow.preset !== "custom"
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
  const candidates = draft.connections.filter((connection) => role === "image" || !isImagesOnlyKind(connection.kind));
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
            const chosen = draft.connections.find((entry) => entry.id === id);
            onChange({ connectionId: id, model: role === "image" && chosen ? connectionKindInfo(chosen.kind)?.defaultImageModel ?? "" : "" });
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
            placeholder={connection.kind === "gemini" ? (role === "text" ? "gemini-2.5-flash" : "gemini-2.5-flash-image") : connectionKindInfo(connection.kind)?.defaultImageModel ?? "Model id"}
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
  const [logins, setLogins] = useState<Record<string, LoginState>>({});
  const [credits, setCredits] = useState<Record<string, CreditState>>({});
  const closed = useRef(false);
  useEffect(() => () => { closed.current = true; }, []);

  useEffect(() => {
    void api.me().then((me) => { setIsOwner(me.isOwner === true); }).catch(() => undefined);
  }, []);

  const loadCredits = (connectionId: string) => {
    setCredits((current) => ({ ...current, [connectionId]: { state: "loading" } }));
    api.aiCredits(connectionId)
      .then((result) => { setCredits((current) => ({ ...current, [connectionId]: { state: "ok", ...result } })); })
      .catch((reason: unknown) => {
        setCredits((current) => ({ ...current, [connectionId]: { state: "error", message: reason instanceof Error ? reason.message : "Couldn't read the credits" } }));
      });
  };

  useEffect(() => {
    void api.aiSettings().then((settings) => {
      setDraft(toDraft(settings));
      for (const connection of settings.connections) {
        if (isAccountKind(connection.kind) && connection.hasKey && !connection.house) {
          loadCredits(connection.id);
        }
      }
    }).catch((reason: unknown) => {
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

  /**
   * Logs in to an account connection: saves first (the server must know the
   * connection), opens the service's page in a new tab, then waits for the
   * server to say the login went through.
   */
  const logIn = async (connectionId: string) => {
    if (!draft) {
      return;
    }
    // Opened right away so the browser treats it as the click's own tab.
    const tab = window.open("about:blank", "_blank");
    if (tab) {
      tab.opener = null;
    }
    setLogins((current) => ({ ...current, [connectionId]: { state: "starting" } }));
    const fail = (message: string) => {
      tab?.close();
      setLogins((current) => ({ ...current, [connectionId]: { state: "error", message } }));
    };
    if (!(await save(draft))) {
      fail("Save the settings first (see the message below).");
      return;
    }
    let started;
    try {
      started = await api.aiLogin(connectionId);
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : "Couldn't start the login");
      return;
    }
    if (tab && !tab.closed) {
      tab.location.href = started.url;
    } else {
      window.open(started.url, "_blank", "noopener");
    }
    setLogins((current) => ({ ...current, [connectionId]: { state: "waiting", url: started.url, code: started.code } }));
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && !closed.current) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let status;
      try {
        status = await api.aiLoginStatus(started.id);
      } catch {
        fail("The login was interrupted (the server restarted?). Try again.");
        return;
      }
      if (status.state === "error") {
        setLogins((current) => ({ ...current, [connectionId]: { state: "error", message: status.error ?? "The login failed." } }));
        return;
      }
      if (status.state === "done") {
        const fresh = (await api.aiSettings()).connections.find((entry) => entry.id === connectionId);
        setDraft((current) => current && {
          ...current,
          connections: current.connections.map((entry) => (entry.id === connectionId ? { ...entry, apiKey: undefined, hasKey: fresh?.hasKey, account: fresh?.account } : entry)),
        });
        invalidateAiSettings();
        setLogins((current) => ({ ...current, [connectionId]: { state: "done" } }));
        loadCredits(connectionId);
        return;
      }
    }
    if (!closed.current) {
      fail("The login wasn't finished in time. Try again.");
    }
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
      name: kind === "openai" ? "Local LLM" : kindLabel(kind),
      ...(kind === "comfyui" ? { workflow: DEFAULT_FLUX3_KLEIN } : {}),
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
            login={logins[connection.id]}
            credits={credits[connection.id]}
            onLogin={() => { void logIn(connection.id); }}
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
                {AI_CONNECTION_KINDS.filter((kind) => isOwner || kind.account !== true).map((kind) => (
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

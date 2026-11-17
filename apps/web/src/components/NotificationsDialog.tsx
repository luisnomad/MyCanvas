import { useEffect, useState } from "react";
import { type NotificationSettings, type NotificationSettingsChange, type NotificationTestResult, api } from "../api";

/*
 * Notifications / Notificaciones: where MyCanvas tells you that a customer
 * approved a shared design, asked for changes, or downloaded the approved
 * PDF. Each person has their own settings (server: notify.ts); tokens are
 * stored encrypted and only ever shown masked.
 */

/** A secret the server only shows masked: type a new one to replace it, or remove it. */
interface SecretDraft { value: string; cleared: boolean }

const EMPTY: SecretDraft = { value: "", cleared: false };

function secretChange(draft: SecretDraft): string | null | undefined {
  if (draft.cleared) {
    return null;
  }
  return draft.value.trim() === "" ? undefined : draft.value.trim();
}

function SecretField({ label, saved, draft, onChange, placeholder }: {
  label: string;
  saved: string | null;
  draft: SecretDraft;
  onChange: (draft: SecretDraft) => void;
  placeholder: string;
}) {
  const showSaved = saved !== null && !draft.cleared;
  return (
    <label className="field field-wide">
      <span>{label}</span>
      <span className="notify-secret-row">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={showSaved ? `Saved ${saved} (type to replace)` : placeholder}
          value={draft.value}
          onChange={(e) => { onChange({ value: e.target.value, cleared: false }); }}
        />
        {showSaved && (
          <button type="button" className="secondary" onClick={() => { onChange({ value: "", cleared: true }); }}>
            Remove
          </button>
        )}
        {draft.cleared && (
          <button type="button" className="secondary" onClick={() => { onChange(EMPTY); }}>
            Undo
          </button>
        )}
      </span>
      {draft.cleared && <span className="muted notify-note">Removed when you save.</span>}
    </label>
  );
}

export function NotificationsDialog({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<NotificationSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [botToken, setBotToken] = useState<SecretDraft>(EMPTY);
  const [chatId, setChatId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState<SecretDraft>(EMPTY);
  const [topic, setTopic] = useState("");
  const [notifyOnOpen, setNotifyOnOpen] = useState(true);
  const [webhookToken, setWebhookToken] = useState<SecretDraft>(EMPTY);
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [test, setTest] = useState<NotificationTestResult | null>(null);

  const reset = (settings: NotificationSettings) => {
    setSaved(settings);
    setBotToken(EMPTY);
    setWebhookUrl(EMPTY);
    setWebhookToken(EMPTY);
    setChatId(settings.telegram.chatId);
    setTopic(settings.webhook.topic);
    setNotifyOnOpen(settings.notifyOnOpen);
  };

  useEffect(() => {
    api.notificationSettings().then(reset).catch((reason: unknown) => {
      setLoadError(reason instanceof Error ? reason.message : "Couldn't load the settings.");
    });
  }, []);

  const change = (): NotificationSettingsChange => ({
    telegram: { botToken: secretChange(botToken), chatId },
    webhook: { url: secretChange(webhookUrl), topic, token: secretChange(webhookToken) },
    notifyOnOpen,
  });

  const dirty = saved !== null && (
    secretChange(botToken) !== undefined || secretChange(webhookUrl) !== undefined || secretChange(webhookToken) !== undefined ||
    chatId.trim() !== saved.telegram.chatId || topic.trim() !== saved.webhook.topic ||
    notifyOnOpen !== saved.notifyOnOpen
  );

  const save = async (): Promise<boolean> => {
    setError(null);
    setMessage(null);
    setTest(null);
    try {
      reset(await api.saveNotificationSettings(change()));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't save. Try again.");
      return false;
    }
  };

  const sendTest = async () => {
    setBusy("testing");
    try {
      if (dirty && !await save()) {
        return;
      }
      setError(null);
      setTest(null);
      const result = await api.testNotifications();
      setTest(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The test couldn't be sent.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog notify-dialog"
        role="dialog"
        aria-label="Notifications"
        onClick={(e) => { e.stopPropagation(); }}
      >
        <h2>Notifications</h2>
        <p className="muted">
          Get a message when a customer approves a shared design, asks for changes or downloads the approved PDF.
          These settings are yours only; tokens are stored encrypted and shown masked.
        </p>
        {!saved && !loadError && <p className="muted">Loading…</p>}
        {loadError && <p className="form-error">{loadError}</p>}

        {saved && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy("saving");
              void save().then((ok) => {
                setBusy(null);
                if (ok) {
                  setMessage("Saved.");
                }
              });
            }}
          >
            <section className="notify-section">
              <h3>When</h3>
              <p className="muted notify-note">Always: approvals, change requests and downloads.</p>
              <label className="share-check">
                <input type="checkbox" checked={notifyOnOpen} onChange={(e) => { setNotifyOnOpen(e.target.checked); }} />
                <span>Notify when a link is opened (first open by each new visitor, or a return after 30 min; at most one message per link every 10 min)</span>
              </label>
            </section>

            <section className="notify-section">
              <h3>Telegram</h3>
              <SecretField label="Bot token" saved={saved.telegram.botToken} draft={botToken} onChange={setBotToken} placeholder="123456789:AAH…" />
              <label className="field field-wide">
                <span>Chat ID</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="123456789"
                  value={chatId}
                  onChange={(e) => { setChatId(e.target.value); }}
                />
              </label>
              <details className="notify-help">
                <summary>How to get these</summary>
                <ol>
                  <li>
                    In Telegram, open
                    {" "}
                    <strong>@BotFather</strong>
                    , send
                    {" "}
                    <code>/newbot</code>
                    {" "}
                    and follow the steps. It replies with the bot token.
                  </li>
                  <li>Open your new bot and send it any message (bots can only write to people who wrote to them first).</li>
                  <li>
                    For the chat ID, message
                    {" "}
                    <strong>@userinfobot</strong>
                    {" "}
                    (it replies with your ID), or open
                    {" "}
                    <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code>
                    {" "}
                    and copy
                    {" "}
                    <code>chat.id</code>
                    . A group ID starts with -100.
                  </li>
                </ol>
              </details>
            </section>

            <section className="notify-section">
              <h3>Webhook (optional)</h3>
              <p className="muted notify-note">A JSON POST on every event. For ntfy, use the server root (e.g. https://ntfy.sh/) and a topic.</p>
              <SecretField label="URL" saved={saved.webhook.url} draft={webhookUrl} onChange={setWebhookUrl} placeholder="https://ntfy.sh/" />
              <label className="field field-wide">
                <span>Topic (ntfy)</span>
                <input type="text" autoComplete="off" placeholder="mycanvas-luis" value={topic} onChange={(e) => { setTopic(e.target.value); }} />
              </label>
              <SecretField label="Bearer token (optional)" saved={saved.webhook.token} draft={webhookToken} onChange={setWebhookToken} placeholder="tk_…" />
            </section>

            {test && (
              <ul className="notify-results" role="status">
                {test.results.map((result) => (
                  <li key={result.channel} className={result.ok ? "notify-ok" : "notify-fail"}>
                    {result.channel === "telegram" ? "Telegram" : "Webhook"}
                    {": "}
                    {result.ok ? "sent. Check your phone." : `failed (${result.error ?? "unknown error"})`}
                  </li>
                ))}
              </ul>
            )}
            {message && <p className="muted" role="status">{message}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}

            <div className="dialog-actions">
              <button type="button" className="secondary" disabled={busy !== null} onClick={() => { void sendTest(); }}>
                {busy === "testing" ? "Sending…" : "Send test notification"}
              </button>
              <span className="share-actions-spacer" />
              <button type="button" className="secondary" onClick={onClose}>Close</button>
              <button type="submit" className="primary" disabled={busy !== null || !dirty}>
                {busy === "saving" ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

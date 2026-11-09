import { useEffect, useState } from "react";
import { type AdminAiSettings, api } from "../../api";

/**
 * Owner only: which other accounts may use AI tools on this server's local
 * network (e.g. models on your own GPU machine). Cloud services and tools on
 * a person's own computer don't need this.
 */
export function AdminAiSection() {
  const [settings, setSettings] = useState<AdminAiSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.me().then((me) => {
      if (me.isOwner) {
        void api.adminAi().then(setSettings).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, []);

  if (!settings) {
    return null;
  }

  const toggle = (email: string, allowed: boolean) => {
    const next = allowed ? [...settings.aiLocalNetwork, email] : settings.aiLocalNetwork.filter((entry) => entry !== email);
    setSettings({ ...settings, aiLocalNetwork: next });
    setError(null);
    api.saveAdminAi(next).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Couldn't save");
    });
  };

  return (
    <section className="ai-admin">
      <h3 className="ai-section-title">Admin · your local network</h3>
      <p className="muted ai-role-hint">
        Accounts allowed to use connections on this server&apos;s network (like your GPU machine). You always can. Others can still use cloud services and tools on their own computer.
      </p>
      {settings.accounts.length === 0 && <p className="muted ai-role-hint">No other accounts can sign in yet.</p>}
      {settings.accounts.map((email) => (
        <label key={email} className="ai-check">
          <input
            type="checkbox"
            checked={settings.aiLocalNetwork.includes(email)}
            onChange={(e) => { toggle(email, e.target.checked); }}
          />
          {email}
        </label>
      ))}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

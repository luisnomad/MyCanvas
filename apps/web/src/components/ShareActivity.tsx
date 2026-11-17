import { useCallback, useEffect, useMemo, useState } from "react";
import { type ShareActivity as Activity, type ShareActivityEvent, api } from "../api";
import { onLive } from "../utils/live";

/*
 * The design's share activity in the Share dialog: who opened the link and
 * when, from which device, plus wrong PINs, link previews, change requests,
 * approvals and downloads, from every link the design has had. In Spanish or
 * English after the browser's language. Your own opens (the editor, Claude)
 * and link previews are hidden unless asked for, and never counted.
 */

type Lang = "es" | "en";

const TEXT = {
  es: {
    title: "Actividad",
    none: "Nadie ha abierto el enlace todavía.",
    opened: (n: number) => (n === 1 ? "Abierto 1 vez" : `Abierto ${String(n)} veces`),
    devices: (n: number) => (n === 1 ? "1 dispositivo" : `${String(n)} dispositivos`),
    ips: (n: number) => (n === 1 ? "1 IP" : `${String(n)} IP`),
    last: (when: string) => `último ${when}`,
    allVisitors: "Todos los visitantes",
    visitor: (n: number) => `Visitante ${String(n)}`,
    showMine: "Mostrar mis visitas y vistas previas",
    kind: { "opened": "Abierto", "pin-failed": "PIN incorrecto", "preview": "Vista previa del enlace", "approved": "Aprobado", "changes": "Cambios pedidos", "downloaded": "PDF descargado" },
    device: { mobile: "Móvil", tablet: "Tableta", desktop: "Ordenador", bot: "Bot" },
    you: "tú",
    pages: (n: number) => (n === 1 ? "1 página" : `${String(n)} páginas`),
    reloads: (n: number) => (n === 1 ? "1 recarga" : `${String(n)} recargas`),
    by: (name: string) => `por ${name}`,
    failed: "No se ha podido cargar la actividad.",
  },
  en: {
    title: "Activity",
    none: "Nobody has opened the link yet.",
    opened: (n: number) => (n === 1 ? "Opened once" : `Opened ${String(n)} times`),
    devices: (n: number) => (n === 1 ? "1 device" : `${String(n)} devices`),
    ips: (n: number) => (n === 1 ? "1 IP" : `${String(n)} IPs`),
    last: (when: string) => `last ${when}`,
    allVisitors: "All visitors",
    visitor: (n: number) => `Visitor ${String(n)}`,
    showMine: "Show my own visits and link previews",
    kind: { "opened": "Opened", "pin-failed": "Wrong PIN", "preview": "Link preview", "approved": "Approved", "changes": "Changes requested", "downloaded": "PDF downloaded" },
    device: { mobile: "Phone", tablet: "Tablet", desktop: "Computer", bot: "Bot" },
    you: "you",
    pages: (n: number) => (n === 1 ? "1 page" : `${String(n)} pages`),
    reloads: (n: number) => (n === 1 ? "1 reload" : `${String(n)} reloads`),
    by: (name: string) => `by ${name}`,
    failed: "Couldn't load the activity.",
  },
};

const ICON: Record<ShareActivityEvent["kind"], string> = {
  "opened": "◉",
  "pin-failed": "!",
  "preview": "⌁",
  "approved": "✓",
  "changes": "✎",
  "downloaded": "↓",
};

function editorLanguage(): Lang {
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

function relative(iso: string, lang: Lang, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) {
    return lang === "es" ? "ahora mismo" : "just now";
  }
  if (minutes < 60) {
    return format.format(-Math.max(0, minutes), "minute");
  }
  if (minutes < 60 * 24) {
    return format.format(-Math.round(minutes / 60), "hour");
  }
  return format.format(-Math.round(minutes / (60 * 24)), "day");
}

function exact(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "es" ? "es-ES" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function ShareActivityLog({ designId }: { designId: string }) {
  const lang = editorLanguage();
  const t = TEXT[lang];
  const [activity, setActivity] = useState<Activity | null>(null);
  const [failed, setFailed] = useState(false);
  const [visitor, setVisitor] = useState("");
  const [showMine, setShowMine] = useState(false);

  const load = useCallback(() => {
    api.shareActivity(designId).then((next) => { setActivity(next); setFailed(false); }).catch(() => { setFailed(true); });
  }, [designId]);

  useEffect(() => {
    load();
    return onLive((event) => {
      if (((event.type === "share.activity" || event.type === "share.changed") && event.id === designId) || event.type === "reconnected") {
        load();
      }
    });
  }, [designId, load]);

  // Visitors numbered in order of first appearance.
  const visitors = useMemo(() => {
    const order = new Map<string, { n: number; label: string }>();
    for (const event of [...(activity?.events ?? [])].reverse()) {
      if (event.audience === "visitor" && !order.has(event.visitor)) {
        order.set(event.visitor, { n: order.size + 1, label: `${t.device[event.device]} · ${event.browser}` });
      }
    }
    return order;
  }, [activity, t]);

  if (failed && !activity) {
    return <p className="form-error">{t.failed}</p>;
  }
  if (!activity) {
    return null;
  }
  const { summary } = activity;
  const shown = activity.events.filter((event) =>
    (showMine || event.audience === "visitor") && (visitor === "" || event.visitor === visitor));

  return (
    <section className="share-activity" aria-label={t.title}>
      <div className="share-activity-head">
        <strong>{t.title}</strong>
        <span className="muted share-activity-summary">
          {summary.opens === 0
            ? t.none
            : [t.opened(summary.opens), t.devices(summary.visitors), t.ips(summary.ips), summary.lastOpenAt ? t.last(relative(summary.lastOpenAt, lang)) : ""]
                .filter(Boolean).join(" · ")}
        </span>
      </div>
      {(visitors.size > 1 || summary.ownerOpens + summary.previews > 0) && (
        <div className="share-activity-filters">
          {visitors.size > 1 && (
            <select aria-label={t.allVisitors} value={visitor} onChange={(e) => { setVisitor(e.target.value); }}>
              <option value="">{t.allVisitors}</option>
              {[...visitors.entries()].map(([key, info]) => (
                <option key={key} value={key}>{`${t.visitor(info.n)} · ${info.label}`}</option>
              ))}
            </select>
          )}
          {summary.ownerOpens + summary.previews > 0 && (
            <label className="share-activity-mine">
              <input type="checkbox" checked={showMine} onChange={(e) => { setShowMine(e.target.checked); }} />
              <span>{t.showMine}</span>
            </label>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <ol className="share-activity-list">
          {shown.map((event) => {
            const who = event.audience === "visitor" ? visitors.get(event.visitor) : undefined;
            const details = [
              event.device === "bot" ? event.browser : `${t.device[event.device]} · ${event.browser}${event.os ? ` · ${event.os}` : ""}`,
              event.ip,
              event.country,
            ].filter(Boolean).join(" · ");
            const extras = [
              event.name ? t.by(event.name) : "",
              event.kind === "opened" && (event.pagesViewed ?? 1) > 1 ? t.pages(event.pagesViewed ?? 1) : "",
              event.kind === "opened" && (event.views ?? 1) > 1 ? t.reloads((event.views ?? 1) - 1) : "",
              event.sha256 ? `sha ${event.sha256.slice(0, 10)}…` : "",
              `v${String(event.revision)}`,
            ].filter(Boolean).join(" · ");
            return (
              <li key={event.id} className={`share-activity-row activity-${event.kind}${event.audience === "visitor" ? "" : " activity-muted"}`}>
                <span className="share-activity-icon" aria-hidden="true">{ICON[event.kind]}</span>
                <div className="share-activity-body">
                  <div className="share-activity-line">
                    <strong>{t.kind[event.kind]}</strong>
                    {who && <span className="muted">{` · ${t.visitor(who.n)}`}</span>}
                    {event.audience === "owner" && <span className="muted">{` · ${t.you}`}</span>}
                    <span className="share-activity-when muted" title={exact(event.at, lang)}>{relative(event.at, lang)}</span>
                  </div>
                  <div className="muted share-activity-meta" title={event.userAgent ?? ""}>{details}</div>
                  {extras && <div className="muted share-activity-meta">{extras}</div>}
                  {event.comment && <div className="share-activity-comment">{event.comment}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

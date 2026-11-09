import { useEffect, useRef, useState } from "react";
import { type Me, api } from "../api";

let cached: Promise<Me> | null = null;

/** Who is signed in (the workspace being shown), with sign-out when possible. */
export function UserBadge() {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cached ??= api.me();
    void cached.then(setMe).catch(() => {
      cached = null;
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (!me) {
    return null;
  }
  const initial = me.email.charAt(0).toUpperCase();

  return (
    <div className="user-badge" ref={rootRef}>
      <button
        type="button"
        className="user-avatar"
        title={me.email}
        aria-label={`Signed in as ${me.email}`}
        aria-expanded={open}
        onClick={() => { setOpen((prev) => !prev); }}
      >
        {initial}
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <p className="user-menu-email">{me.email}</p>
          <p className="muted user-menu-note">
            {me.via === "access"
              ? "Your designs and uploads are private to this account."
              : "Local network access (owner workspace)."}
          </p>
          {me.logoutUrl && (
            <a className="button-link user-menu-signout" href={me.logoutUrl} role="menuitem">
              Sign out
            </a>
          )}
        </div>
      )}
    </div>
  );
}

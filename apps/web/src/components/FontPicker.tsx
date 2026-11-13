import { useEffect, useRef, useState } from "react";
import { GOOGLE_FONTS, type GoogleFont } from "@mycanvas/shared";
import { api } from "../api";
import { customFonts, deleteCustomFont, uploadCustomFont, useCustomFontsVersion } from "../utils/custom-fonts";
import { ensureFontLoaded, isGoogleFont, listLocalFonts } from "../utils/fonts";

interface FontPickerProps {
  value: string;
  onApply: (family: string) => void;
  /** Borderless, auto-width toggle for embedding in the floating context bar. */
  compact?: boolean;
}

export function FontPicker({ value, onApply, compact = false }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [favorites, setFavorites] = useState<string[] | null>(null);
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);
  useCustomFontsVersion();
  const [fontNotice, setFontNotice] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const groupsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onFavoritesChanged = (event: Event) => {
      setFavorites((event as CustomEvent<string[]>).detail);
    };
    window.addEventListener("font-favorites-changed", onFavoritesChanged);
    return () => { window.removeEventListener("font-favorites-changed", onFavoritesChanged); };
  }, []);

  // Close when clicking outside the dropdown.
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

  // Lazy-load favorites and system fonts the first time the dropdown opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (favorites === null) {
      void api
        .getFontFavorites()
        .then((res) => {
          setFavorites((current) => current ?? res.googleFontFavorites);
        })
        .catch(() => {
          setFavorites((current) => current ?? []);
        });
    }
    if (systemFonts === null) {
      void listLocalFonts(api.systemFonts)
        .then(setSystemFonts)
        .catch(() => {
          setSystemFonts([]);
        });
    }
  }, [open, favorites, systemFonts]);

  const apply = (family: string) => {
    if (isGoogleFont(family)) {
      void ensureFontLoaded(family);
    }
    onApply(family);
    setOpen(false);
  };

  const toggleFavorite = (family: string) => {
    const current = favorites ?? [];
    const next = current.includes(family)
      ? current.filter((fav) => fav !== family)
      : [...current, family];
    setFavorites(next);
    window.dispatchEvent(new CustomEvent("font-favorites-changed", { detail: next }));
    if (!current.includes(family)) {
      // The star is usually clicked deep in the long Google Fonts list.
      // Reveal the newly added favorite at the top of this dropdown.
      requestAnimationFrame(() => { groupsRef.current?.scrollTo({ top: 0, behavior: "smooth" }); });
    }
    void api.setFontFavorites(next).catch(() => {
      setFavorites(current);
      window.dispatchEvent(new CustomEvent("font-favorites-changed", { detail: current }));
    });
  };

  const query = filter.trim().toLowerCase();
  const matches = (family: string) => !query || family.toLowerCase().includes(query);

  const favoriteFonts = (favorites ?? []).filter(matches);
  const ownFamilies = [...new Set(customFonts().map((font) => font.family))].filter(matches);

  const addFonts = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setUploading(true);
    setFontNotice(null);
    const added: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const font = await uploadCustomFont(file);
        added.push(`${font.family} ${String(font.weight)}${font.italic ? " italic" : ""}`);
      }
      setFontNotice({ kind: "ok", text: `Added ${added.join(", ")}` });
    } catch (reason) {
      setFontNotice({ kind: "error", text: reason instanceof Error ? reason.message : "The font couldn't be added" });
    } finally {
      setUploading(false);
    }
  };

  const removeFamily = (family: string) => {
    if (!window.confirm(`Remove "${family}" from your fonts? Text using it will show another font.`)) {
      return;
    }
    void Promise.all(customFonts().filter((font) => font.family === family).map((font) => deleteCustomFont(font.id)))
      .catch(() => { setFontNotice({ kind: "error", text: "The font couldn't be removed" }); });
  };
  const googleFonts = GOOGLE_FONTS.filter((font) => matches(font.family));
  const localFonts = (systemFonts ?? []).filter(matches);

  const renderGoogleRow = (font: GoogleFont) => {
    const isFavorite = (favorites ?? []).includes(font.family);
    return (
      <div key={font.family} className="font-row">
        <button
          type="button"
          className="font-name"
          style={{ fontFamily: `"${font.family}", ${font.category}` }}
          onMouseEnter={() => {
            void ensureFontLoaded(font.family);
          }}
          onClick={() => {
            apply(font.family);
          }}
        >
          {font.family}
        </button>
        <button
          type="button"
          className={isFavorite ? "icon-button star active" : "icon-button star"}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          onClick={() => {
            toggleFavorite(font.family);
          }}
        >
          {isFavorite ? "★" : "☆"}
        </button>
      </div>
    );
  };

  return (
    <div className={compact ? "font-picker compact" : "font-picker"} ref={rootRef}>
      <button
        type="button"
        className="font-picker-toggle"
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        <span style={{ fontFamily: `"${value}"` }}>{value}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="font-dropdown">
          <input
            className="font-filter"
            placeholder="Filter fonts…"
            value={filter}
            autoFocus
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
          <div className="font-groups" ref={groupsRef}>
            <div className="font-group">
              <div className="font-group-head">
                <h4>Your fonts</h4>
                <label className={uploading ? "font-add disabled" : "font-add"} title="Add .ttf or .otf files (one per weight/style)">
                  {uploading ? "Adding…" : "Add font…"}
                  <input
                    type="file"
                    accept=".ttf,.otf"
                    multiple
                    disabled={uploading}
                    onChange={(e) => {
                      void addFonts(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {fontNotice && <p className={fontNotice.kind === "error" ? "font-notice error" : "font-notice"}>{fontNotice.text}</p>}
              {ownFamilies.length === 0 && !query && (
                <p className="muted font-empty">Upload your own fonts (.ttf or .otf). They work in the editor and in PDF exports.</p>
              )}
              {ownFamilies.map((family) => {
                const faces = customFonts().filter((font) => font.family === family);
                const variable = faces.some((font) => font.variable);
                return (
                  <div key={family} className="font-row">
                    <button
                      type="button"
                      className="font-name"
                      style={{ fontFamily: `"${family}"` }}
                      title={variable ? "Variable font: PDF exports use its default weight" : `${String(faces.length)} ${faces.length === 1 ? "style" : "styles"}`}
                      onClick={() => {
                        apply(family);
                      }}
                    >
                      {family}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title={`Remove ${family}`}
                      aria-label={`Remove ${family}`}
                      onClick={() => {
                        removeFamily(family);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            {favoriteFonts.length > 0 && (
              <div className="font-group">
                <h4>Favorites</h4>
                {favoriteFonts.map((family) => {
                  const font = GOOGLE_FONTS.find((entry) => entry.family === family);
                  return font ? renderGoogleRow(font) : null;
                })}
              </div>
            )}
            <div className="font-group">
              <h4>Google Fonts</h4>
              {googleFonts.map(renderGoogleRow)}
            </div>
            <div className="font-group">
              <h4>Installed on this Mac</h4>
              {systemFonts === null && <p className="muted">Loading…</p>}
              {localFonts.map((family) => (
                <div key={family} className="font-row">
                  <button
                    type="button"
                    className="font-name"
                    style={{ fontFamily: `"${family}"` }}
                    onClick={() => {
                      apply(family);
                    }}
                  >
                    {family}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

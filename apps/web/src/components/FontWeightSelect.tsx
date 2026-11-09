import { useEffect, useState } from "react";
import { FONT_WEIGHTS, formatFontStyle, parseFontStyle } from "@mycanvas/shared";
import { availableWeights } from "../utils/fonts";

interface FontWeightSelectProps {
  fontFamily: string;
  fontStyle: string;
  onChange: (fontStyle: string) => void;
  className?: string;
}

/**
 * Weight menu (Thin … Black). Google fonts list only the weights the family
 * really has; installed fonts list all, and the browser uses the nearest face.
 */
export function FontWeightSelect({ fontFamily, fontStyle, onChange, className }: FontWeightSelectProps) {
  const { weight, italic } = parseFontStyle(fontStyle);
  const [weights, setWeights] = useState<number[] | null>(null);

  useEffect(() => {
    const probe = availableWeights(fontFamily);
    if (!probe) {
      setWeights(FONT_WEIGHTS.map((entry) => entry.weight));
      return;
    }
    let cancelled = false;
    setWeights(null);
    void probe.then((found) => {
      if (!cancelled) {
        setWeights(found);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fontFamily]);

  const options = FONT_WEIGHTS.filter((entry) => entry.weight === weight || (weights ?? [400, 700]).includes(entry.weight));
  const missing = weights !== null && !weights.includes(weight);

  return (
    <select
      className={className}
      value={weight}
      aria-label="Font weight"
      title={missing ? `${fontFamily} has no ${String(weight)} weight; the nearest one is shown` : "Font weight"}
      onChange={(e) => {
        onChange(formatFontStyle({ weight: Number(e.target.value), italic }));
      }}
    >
      {options.map((entry) => (
        <option key={entry.weight} value={entry.weight}>
          {`${entry.label} ${String(entry.weight)}${entry.weight === weight && missing ? " (not in font)" : ""}`}
        </option>
      ))}
    </select>
  );
}

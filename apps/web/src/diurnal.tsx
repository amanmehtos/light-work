/**
 * Light Week's hold on Diurnal UI.
 *
 * Diurnal is a CSS library with a small runtime, not a component framework:
 * importing the stylesheet and the module is the whole setup, and components
 * are `.dn-*` classes in ordinary markup. Wrapping each one in React would add
 * indirection and a second place for the class names to drift, so the app uses
 * them directly and this file only covers what genuinely needs React — reading
 * the current light.
 */

import { useEffect, useState } from "react";
import { ICONS, diurnal, type DiurnalInfo } from "diurnal-ui/diurnal.mjs";

export { diurnal };
export type { DiurnalInfo };

// The end-to-end harness drives the sky directly — previewing an hour, reading
// back the variables the library wrote. Exposed only in development, because a
// global handle on the theme is a debugging affordance, not an API.
if (import.meta.env.DEV) {
  (globalThis as unknown as { diurnal?: typeof diurnal }).diurnal = diurnal;
}

/**
 * The current light: which body is casting it, where it is, and what the
 * weather is doing to it. Re-renders when the sky moves, which is once a
 * minute at most.
 */
export function useDiurnal(): DiurnalInfo | null {
  const [info, setInfo] = useState<DiurnalInfo | null>(null);

  useEffect(() => {
    // subscribe() calls back immediately with the current state, so there is
    // no first-paint gap to cover.
    return diurnal.subscribe(setInfo);
  }, []);

  return info;
}

/** A sentence describing the light, for the header's tooltip. */
export function describeLight(info: DiurnalInfo | null): string {
  if (info === null) return "";
  const body = info.source.body === "moon" ? "Moonlight" : "Sunlight";
  // `alt` is degrees above the horizon, not a 0..1 fraction.
  const alt = info.source.alt;
  const height = alt <= 0 ? "below the horizon" : alt < 15 ? "low" : alt < 45 ? "climbing" : "high";
  const sky = info.weather as { label?: string } | undefined;
  const weather = typeof sky?.label === "string" ? `, ${sky.label.toLowerCase()}` : "";
  return `${body}, ${height}${weather}`;
}

/**
 * The sun / moon switch.
 *
 * Diurnal mounts its own `[data-dn-toggle]` buttons by scanning the document
 * when the module loads, which happens before React has rendered anything —
 * so in a React app the control has to be built here instead. It is the same
 * button: the library's classes, the library's icons, and `diurnal.toggle()`
 * doing the work.
 */
export function ThemeToggle({ title }: { title?: string }) {
  const info = useDiurnal();
  const mode = info?.mode ?? "light";
  const isDark = mode === "dark";

  return (
    <button
      type="button"
      className="dn-btn dn-btn--icon"
      title={title ?? (isDark ? "Moonlit — switch to sunlight" : "Sunlit — switch to moonlight")}
      aria-label={isDark ? "Switch to light mode (sun)" : "Switch to dark mode (moon)"}
      onClick={() => diurnal.toggle()}
      dangerouslySetInnerHTML={{ __html: ICONS[isDark ? "moon" : "sun"] }}
    />
  );
}

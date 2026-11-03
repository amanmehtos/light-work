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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ICONS, diurnal, type DiurnalInfo } from "diurnal-ui/diurnal.mjs";
import { sheet, type SheetApi } from "diurnal-ui/fluid.mjs";
import { skyHeader } from "diurnal-ui/sky-header.mjs";

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

/**
 * The weather overhead, as a band.
 *
 * The library mounts itself on every `[data-dn-sky]` when it is imported,
 * which is right for a static page and no use here: React renders this long
 * after that has run. So the band is mounted by hand. `skyHeader` ignores an
 * element it already holds, so neither path can double it up.
 */
export function Sky({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current !== null) skyHeader(ref.current);
  }, []);
  return <div ref={ref} className={`dn-sky ${className}`} aria-hidden="true" />;
}

/**
 * Whether the page has scrolled at all.
 *
 * Diurnal does this itself for `[data-dn-scroll-edge]` headers, but it collects
 * them when the module is imported — before React has rendered anything — so in
 * this app the class was never once applied. Nobody noticed while the masthead
 * was an opaque card; the moment it became type on the sky, content started
 * showing straight through it. Same threshold the library uses.
 */
export function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > 4);
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

/**
 * A bottom sheet.
 *
 * Another case of the library mounting itself before React exists: `fluid.mjs`
 * scans for `.dn-sheet` on import, finds none, and the sheet would sit at
 * `translateY(100%)` for ever. So it is mounted by hand here, and `open` is a
 * prop rather than a class — the spring and the drag-to-dismiss are the
 * library's, this only tells it which way to go.
 *
 * The markup stays in the tree while closed, because `sheet()` animates an
 * element it is holding; unmounting it would mean a new spring every time and
 * no closing animation at all.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<SheetApi | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (ref.current === null) return;
    api.current = sheet(ref.current);
    // The library closes itself on the scrim, on Escape and on a downward
    // flick, none of which go through our `open` prop — so React has to hear
    // about it or the next open would be a no-op against a stale `true`.
    const el = ref.current;
    const observer = new MutationObserver(() => {
      if (el.hidden) onCloseRef.current();
    });
    observer.observe(el, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (api.current === null) return;
    if (open) api.current.open();
    else if (api.current.isOpen) api.current.close();
  }, [open]);

  return (
    <div className="dn-sheet" ref={ref} hidden>
      <div className="dn-sheet__scrim" />
      <div
        className="dn-sheet__panel dn-material dn-material--thick"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="dn-sheet__handle" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

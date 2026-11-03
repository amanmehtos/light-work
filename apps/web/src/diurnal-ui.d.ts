/**
 * Types for Diurnal UI.
 *
 * The library is plain ES modules with no TypeScript, so this describes the
 * surface this app actually uses. It is deliberately not exhaustive — anything
 * added here should match `vendor/diurnal-ui/diurnal.mjs`, which is the real
 * contract.
 */

declare module "diurnal-ui/diurnal.css";

/** Imported for its side effect: it mounts itself on every [data-dn-sky]. */
declare module "diurnal-ui/sky-header.mjs" {
  export function skyHeader(el: HTMLElement): void;
}

declare module "diurnal-ui/diurnal.mjs" {
  export type DiurnalMode = "light" | "dark";
  export type WeatherMode = "live" | "clear" | "partly" | "overcast" | "rain" | "fog";

  /** Matches `lightSource()` in sky.mjs: both angles are in degrees. */
  export interface LightSource {
    /** Which body is doing the lighting: the sun in light mode, the moon in dark. */
    body: "sun" | "moon";
    /** Altitude above the horizon, in degrees. Negative below it. */
    alt: number;
    /** Azimuth from north, clockwise, in degrees. */
    az: number;
  }

  /** Matches `shadowFor()` in sky.mjs. */
  export interface ShadowParams {
    /** False once the light is below the horizon, leaving only skylight. */
    up: boolean;
    dx: number;
    dy: number;
    nx: number;
    ny: number;
    blur: number;
    alpha: number;
    rim: number;
    /** 0 is hard direct light, 1 is no direct light at all. */
    diffusion: number;
  }

  export interface DiurnalInfo {
    motion: "fluid" | "classic";
    mode: DiurnalMode;
    when: Date;
    place: { lat: number; lon: number };
    source: LightSource;
    shadow: ShadowParams;
    weather: Record<string, unknown>;
    weatherMode: WeatherMode;
    weatherAt?: number;
  }

  export const diurnal: {
    readonly mode: DiurnalMode;
    readonly motion: "fluid" | "classic";
    readonly place: { lat: number; lon: number };
    setMode(mode: DiurnalMode): DiurnalInfo;
    toggle(): DiurnalInfo;
    setPlace(place: { lat: number; lon: number }): DiurnalInfo;
    /** Preview another time of day, or null to follow the clock again. */
    preview(date: Date | null): DiurnalInfo;
    setWeather(mode: WeatherMode): DiurnalInfo;
    setMotion(motion: "fluid" | "classic"): DiurnalInfo;
    subscribe(fn: (info: DiurnalInfo) => void): () => void;
    refresh(): DiurnalInfo;
  };

  export const ICONS: { sun: string; moon: string };
}

declare module "diurnal-ui/dialog.mjs" {
  export function ask(options: Record<string, unknown>): Promise<unknown>;
  export function confirmAction(options: Record<string, unknown>): Promise<boolean>;
}

declare module "diurnal-ui/fluid.mjs" {
  /** What `sheet()` hands back: a sheet that can be opened and closed. */
  export interface SheetApi {
    /** `from` is the control that opened it, which gets focus back on close. */
    open(from?: Element | null): void;
    close(): void;
    readonly isOpen: boolean;
  }

  /**
   * Mounts the spring and the drag-to-dismiss on a `.dn-sheet`, and returns
   * the same api on every later call for that element.
   */
  export function sheet(el: HTMLElement): SheetApi;
  export function enhanceSwitch(label: HTMLElement): void;
  export function enhanceSeg(seg: HTMLElement): void;
}

declare module "diurnal-ui/motion.mjs" {
  /**
   * Pointer dragging with 1:1 movement.
   *
   * `onMove` fires only once the pointer has travelled past `threshold`, so a
   * plain tap still reaches `onTap` and the element's own click handler.
   */
  export function drag(
    el: HTMLElement,
    options: {
      axis?: "x" | "y" | "both";
      threshold?: number;
      onStart?: (e: PointerEvent) => void;
      onMove?: (info: { dx: number; dy: number; e: PointerEvent }) => void;
      onEnd?: (info: {
        dx: number;
        dy: number;
        vx: number;
        vy: number;
        cancelled: boolean;
        e: PointerEvent;
      }) => void;
      onTap?: (e: PointerEvent) => void;
    },
  ): void;
}

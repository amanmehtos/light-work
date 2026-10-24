/**
 * Types for Diurnal UI.
 *
 * The library is plain ES modules with no TypeScript, so this describes the
 * surface this app actually uses. It is deliberately not exhaustive — anything
 * added here should match `vendor/diurnal-ui/diurnal.mjs`, which is the real
 * contract.
 */

declare module "diurnal-ui/diurnal.css";

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

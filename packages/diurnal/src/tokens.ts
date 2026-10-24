/**
 * Turning a sun position into CSS.
 *
 * Components never read the sun directly. They declare an elevation, and these
 * custom properties — set once on the root and updated as the day moves — do
 * the rest. One `box-shadow` expression in the stylesheet then serves every
 * component at every hour.
 *
 * What deliberately does *not* vary with time is text and background contrast.
 * A theme that drifts through the day is a good way to end up with something
 * unreadable at 4pm, so the palette switches between exactly two states, light
 * and dark, and only the light — shadows, highlights, warmth — is continuous.
 */

import type { SunPosition } from "./sun.js";

export interface DiurnalTokens {
  /** Unit direction the shadow falls, in page coordinates. */
  shadowX: number;
  shadowY: number;
  /** Pixels of offset per unit of elevation. */
  shadowLength: number;
  /** Pixels of blur per unit of elevation. */
  shadowBlur: number;
  /** Opacity of the cast shadow. */
  shadowAlpha: number;
  /** Opacity of the tight contact shadow that sits under every raised thing. */
  contactAlpha: number;
  /** Unit direction the light comes from, for edge highlights. */
  lightX: number;
  lightY: number;
  /** Strength of the lit edge. */
  highlightAlpha: number;
  warmth: number;
  daylight: number;
  altitude: number;
  lateral: number;
  /** Which palette to use. */
  scheme: "light" | "dark";
}

/** Shortest and longest a shadow gets, per unit of elevation. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 12;
const MIN_BLUR = 4;
const MAX_BLUR = 14;

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface TokenOptions {
  /**
   * "follow" switches to the dark palette once the sun is down, which is the
   * point of the thing. The explicit values exist because someone working at
   * night in a bright room is entitled to overrule the sky.
   */
  scheme?: "follow" | "light" | "dark";
}

export function tokensFor(sun: SunPosition, options: TokenOptions = {}): DiurnalTokens {
  // How far the sun is from overhead: 0 at the zenith, 1 at the horizon and
  // below. This is what makes shadows stretch towards the ends of the day.
  const spread = 1 - Math.max(sun.altitude, 0);

  // Light from the left throws shadows to the right, so the shadow opposes the
  // sun's lateral position. The vertical component never reverses: the light
  // is always above the page, so things always cast downwards.
  const shadowX = -sun.lateral * spread;
  const shadowY = lerp(0.25, 1, spread);

  const schemeOption = options.scheme ?? "follow";
  const scheme =
    schemeOption === "follow" ? (sun.daylight < 0.4 ? "dark" : "light") : schemeOption;

  return {
    shadowX: round(shadowX),
    shadowY: round(shadowY),
    shadowLength: round(lerp(MIN_LENGTH, MAX_LENGTH, spread), 2),
    shadowBlur: round(lerp(MIN_BLUR, MAX_BLUR, spread), 2),
    // Midday sun is hard and dark; low light and night are soft and faint.
    shadowAlpha: round(lerp(0.1, 0.22, sun.daylight)),
    contactAlpha: round(lerp(0.05, 0.09, sun.daylight)),
    lightX: round(sun.lateral),
    lightY: -1,
    highlightAlpha: round(lerp(0.04, 0.14, sun.daylight)),
    warmth: round(sun.warmth),
    daylight: round(sun.daylight),
    altitude: round(sun.altitude),
    lateral: round(sun.lateral),
    scheme,
  };
}

/** The custom properties, ready to set on an element. */
export function cssVariables(tokens: DiurnalTokens): Record<string, string> {
  return {
    "--dn-shadow-x": String(tokens.shadowX),
    "--dn-shadow-y": String(tokens.shadowY),
    "--dn-shadow-length": `${tokens.shadowLength}px`,
    "--dn-shadow-blur": `${tokens.shadowBlur}px`,
    "--dn-shadow-alpha": String(tokens.shadowAlpha),
    "--dn-contact-alpha": String(tokens.contactAlpha),
    "--dn-light-x": String(tokens.lightX),
    "--dn-light-y": String(tokens.lightY),
    "--dn-highlight-alpha": String(tokens.highlightAlpha),
    "--dn-warmth": String(tokens.warmth),
    "--dn-daylight": String(tokens.daylight),
    "--dn-altitude": String(tokens.altitude),
    "--dn-lateral": String(tokens.lateral),
  };
}

/** Writes the tokens onto an element, and marks the palette on it. */
export function applyTokens(element: HTMLElement, tokens: DiurnalTokens): void {
  for (const [name, value] of Object.entries(cssVariables(tokens))) {
    element.style.setProperty(name, value);
  }
  element.dataset.dnScheme = tokens.scheme;
}

/**
 * A readable description of the current light, for the SunDial's tooltip and
 * for anyone wondering why the shadows moved.
 */
export function describeLight(sun: SunPosition): string {
  if (sun.isNight) return "After dark — soft, cool light";
  if (sun.altitude < 0.2) return sun.lateral < 0 ? "Low morning sun" : "Low evening sun";
  if (sun.altitude < 0.5) return sun.lateral < 0 ? "Mid-morning sun" : "Afternoon sun";
  return "High sun, short shadows";
}

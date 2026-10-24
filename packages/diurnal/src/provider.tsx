/**
 * Installing the light.
 *
 * The provider computes the sun's position, writes the custom properties onto
 * the document root, and re-does it on a slow tick. Components read nothing
 * from context to render — they are plain CSS classes — so a re-render here
 * costs nothing beyond the components that actually want the numbers, like the
 * sundial.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { sunPosition, type SunOptions, type SunPosition } from "./sun.js";
import { applyTokens, tokensFor, type DiurnalTokens, type TokenOptions } from "./tokens.js";

export interface DiurnalContextValue {
  sun: SunPosition;
  tokens: DiurnalTokens;
}

const DiurnalContext = createContext<DiurnalContextValue | null>(null);

export interface DiurnalProviderProps extends SunOptions, TokenOptions {
  children: ReactNode;
  /**
   * How often to recompute, in milliseconds. A minute is ample: over a whole
   * day the light moves about a quarter of a degree a minute, and anything
   * faster is burning wakeups to animate something nobody is watching.
   */
  tickMs?: number;
  /** Fixed time, for stories, screenshots and tests. */
  now?: () => Date;
  /**
   * Where to write the custom properties. Defaults to the document root so the
   * whole page is lit; pass an element to scope it, which is what a component
   * gallery wants when showing several hours side by side.
   */
  target?: HTMLElement | null;
}

const DEFAULT_TICK = 60_000;

export function DiurnalProvider({
  children,
  tickMs = DEFAULT_TICK,
  now,
  target,
  scheme,
  ...sunOptions
}: DiurnalProviderProps) {
  const [date, setDate] = useState<Date>(() => (now ? now() : new Date()));

  // The option objects are rebuilt on every render by the caller's JSX, so they
  // are compared by value rather than identity.
  const optionsKey = JSON.stringify(sunOptions);

  useEffect(() => {
    if (now !== undefined) return;
    const id = setInterval(() => setDate(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs, now]);

  const sun = useMemo(
    () => sunPosition(date, sunOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [date, optionsKey],
  );

  const tokens = useMemo(
    () => tokensFor(sun, scheme === undefined ? {} : { scheme }),
    [sun, scheme],
  );

  useEffect(() => {
    const element = target ?? (typeof document === "undefined" ? null : document.documentElement);
    if (element === null) return;
    applyTokens(element, tokens);
  }, [tokens, target]);

  const value = useMemo<DiurnalContextValue>(() => ({ sun, tokens }), [sun, tokens]);

  return <DiurnalContext.Provider value={value}>{children}</DiurnalContext.Provider>;
}

/** The current light. Throws outside a provider, which is always a mistake. */
export function useDiurnal(): DiurnalContextValue {
  const value = useContext(DiurnalContext);
  if (value === null) {
    throw new Error("useDiurnal must be used inside a <DiurnalProvider>");
  }
  return value;
}

export function useSun(): SunPosition {
  return useDiurnal().sun;
}

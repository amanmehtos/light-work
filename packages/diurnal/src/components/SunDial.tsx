/**
 * A small readout of where the light currently is.
 *
 * It earns its place by explaining the rest of the kit: shadows move during
 * the day, and someone who notices deserves to be able to find out why without
 * reading the source.
 */

import type { HTMLAttributes } from "react";
import { useDiurnal } from "../provider.js";
import { describeLight } from "../tokens.js";

export interface SunDialProps extends HTMLAttributes<HTMLDivElement> {
  /** Show the description beside the dial rather than only as a tooltip. */
  withLabel?: boolean;
}

export function SunDial({ withLabel = false, className, ...rest }: SunDialProps) {
  const { sun } = useDiurnal();
  const description = describeLight(sun);

  const dial = (
    <div
      className={["dn-sundial", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={description}
      title={description}
      {...rest}
    >
      <span className="dn-sundial-body" />
    </div>
  );

  if (!withLabel) return dial;

  return (
    <span className="dn-inline" style={{ gap: "var(--dn-space-2)" }}>
      {dial}
      <span className="dn-text dn-text-small dn-text-soft">{description}</span>
    </span>
  );
}

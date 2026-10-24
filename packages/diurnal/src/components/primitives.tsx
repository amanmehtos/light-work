/**
 * The pieces.
 *
 * Every one of these is a thin wrapper over a real element with a class on it.
 * Nothing here holds state or reads the sun — elevation is declared with
 * `--dn-e` and the stylesheet does the lighting — so they stay cheap to render
 * and easy to replace.
 */

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

function classes(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

/** Sets the elevation custom property the stylesheet reads. */
function elevation(level: number | undefined, style?: CSSProperties): CSSProperties {
  if (level === undefined) return style ?? {};
  return { ...style, ["--dn-e" as string]: String(level) };
}

/* ---------------------------------------------------------------- */
/* Surface — the desktop everything sits on                          */
/* ---------------------------------------------------------------- */

export function Surface({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={classes("dn-surface", className)} {...rest}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Panel — a thing resting on the surface                            */
/* ---------------------------------------------------------------- */

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** How high it sits. 1 is a card, 3 is a dialog. */
  level?: number;
  /** Remove the inner padding, for a panel that holds its own list. */
  flush?: boolean;
  /** Sunk into the surface instead of resting on it. */
  inset?: boolean;
}

export function Panel({
  level = 1,
  flush = false,
  inset = false,
  className,
  style,
  children,
  ...rest
}: PanelProps) {
  return (
    <div
      className={classes("dn-panel", inset ? "dn-sunk" : "dn-raised", flush && "dn-panel-flush", className)}
      style={elevation(inset ? undefined : level, style)}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Button                                                            */
/* ---------------------------------------------------------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "default" | "quiet" | "ghost";
  level?: number;
}

export function Button({
  variant = "default",
  level = 1,
  className,
  style,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  // Quiet and ghost sit flat on the surface, so they take no elevation and
  // cast nothing — the distinction between them and a raised button is the
  // whole point of having levels.
  const flat = variant === "quiet" || variant === "ghost";
  return (
    <button
      type={type}
      className={classes(
        "dn-button",
        `dn-button-${variant}`,
        !flat && "dn-raised dn-pressable",
        className,
      )}
      style={flat ? style : elevation(level, style)}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* Field                                                             */
/* ---------------------------------------------------------------- */

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  hint?: string;
  error?: string;
  /** Hide the label visually but keep it for assistive technology. */
  labelHidden?: boolean;
}

let fieldCounter = 0;

export function TextField({
  label,
  hint,
  error,
  labelHidden = false,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const fieldId = id ?? `dn-field-${++fieldCounter}`;
  const hintId = hint === undefined ? undefined : `${fieldId}-hint`;
  const errorId = error === undefined ? undefined : `${fieldId}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={classes("dn-field", className)}>
      {label !== undefined && (
        <label
          htmlFor={fieldId}
          className="dn-field-label"
          style={labelHidden ? visuallyHidden : undefined}
        >
          {label}
        </label>
      )}
      <input
        id={fieldId}
        className="dn-field-input dn-sunk"
        aria-describedby={describedBy}
        aria-invalid={error === undefined ? undefined : true}
        {...rest}
      />
      {hint !== undefined && (
        <span id={hintId} className="dn-field-hint">
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span id={errorId} role="alert" className="dn-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/* ---------------------------------------------------------------- */
/* Checkbox                                                          */
/* ---------------------------------------------------------------- */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /**
   * `r g b` triple to tint the mark, e.g. a task's priority colour.
   *
   * Explicitly admits `undefined`: callers usually hold this as the result of
   * a lookup that may miss, and under `exactOptionalPropertyTypes` a bare
   * optional would reject that.
   */
  tint?: string | undefined;
}

export function Checkbox({ tint, className, style, ...rest }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={classes("dn-checkbox", className)}
      style={tint === undefined ? style : { ...style, ["--dn-mark" as string]: tint }}
      {...rest}
    />
  );
}

/* ---------------------------------------------------------------- */
/* Chip                                                              */
/* ---------------------------------------------------------------- */

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "accent" | "danger" | "outline";
  /** `r g b` triple for a one-off colour, such as a label's own. */
  tint?: string | undefined;
}

export function Chip({ tone = "neutral", tint, className, style, children, ...rest }: ChipProps) {
  const tinted: CSSProperties | undefined =
    tint === undefined
      ? style
      : { ...style, background: `rgb(${tint} / 0.14)`, color: `rgb(${tint})` };
  return (
    <span
      className={classes("dn-chip", tone !== "neutral" && `dn-chip-${tone}`, className)}
      style={tinted}
      {...rest}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* Nav                                                               */
/* ---------------------------------------------------------------- */

export interface NavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: ReactNode;
  count?: number;
  selected?: boolean;
  /** Indentation level, for a nested project tree. */
  depth?: number;
}

export function NavItem({
  label,
  count,
  selected = false,
  depth = 0,
  className,
  style,
  ...rest
}: NavItemProps) {
  return (
    <button
      type="button"
      className={classes("dn-nav-item", className)}
      aria-current={selected ? "page" : undefined}
      style={{ ...style, paddingLeft: `${10 + depth * 14}px` }}
      {...rest}
    >
      <span className="dn-nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="dn-nav-count">{count}</span>}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* Text                                                              */
/* ---------------------------------------------------------------- */

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: 1 | 2 | 3;
}

export function Heading({ level = 1, className, children, ...rest }: HeadingProps) {
  const Tag = (`h${level}`) as "h1" | "h2" | "h3";
  return (
    <Tag className={classes("dn-heading", `dn-heading-${level}`, className)} {...rest}>
      {children}
    </Tag>
  );
}

export interface TextProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "default" | "soft" | "danger";
  size?: "default" | "small";
  strike?: boolean;
  as?: "span" | "p" | "div";
}

export function Text({
  tone = "default",
  size = "default",
  strike = false,
  as: Tag = "span",
  className,
  children,
  ...rest
}: TextProps) {
  return (
    <Tag
      className={classes(
        "dn-text",
        tone !== "default" && `dn-text-${tone}`,
        size === "small" && "dn-text-small",
        strike && "dn-text-strike",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* ---------------------------------------------------------------- */
/* Layout                                                            */
/* ---------------------------------------------------------------- */

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  gap?: 1 | 2 | 3 | 4 | 5 | 6;
  align?: CSSProperties["alignItems"];
}

export function Stack({ gap = 3, align, className, style, children, ...rest }: StackProps) {
  return (
    <div
      className={classes("dn-stack", className)}
      style={{ ...style, gap: `var(--dn-space-${gap})`, alignItems: align }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Inline({ gap = 2, align = "center", className, style, children, ...rest }: StackProps) {
  return (
    <div
      className={classes("dn-inline", className)}
      style={{ ...style, gap: `var(--dn-space-${gap})`, alignItems: align }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Divider({ className, ...rest }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={classes("dn-divider", className)} {...rest} />;
}

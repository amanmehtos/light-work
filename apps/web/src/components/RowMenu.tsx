/**
 * A small menu that hangs off a control in a row.
 *
 * Not a second `.dn-sheet`. `Sheet` in `diurnal.tsx` stays mounted when closed
 * and learns that the library closed it from a `MutationObserver` on `hidden`,
 * because `fluid.mjs` closes a sheet on the scrim, on Escape and on a flick
 * without telling React. A menu built from another sheet would put two of those
 * on the page, both listening for Escape, and the task editor opening over a
 * menu — or the reverse — is the fight that contract exists to prevent. So this
 * is plain markup: a button, and a card of buttons beside it while it is open.
 *
 * It closes itself on a pick, on a press anywhere else, and on Escape, and
 * Escape is only heard while it is open, so it never competes with the sheet.
 * Monochrome and from the library's own classes: a card, ghost buttons, no
 * colour of its own.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  key: string;
  label: string;
  /** Marks the current choice, for a menu that is picking one of several. */
  checked?: boolean;
  onSelect: () => void;
}

export function RowMenu({
  label,
  trigger,
  triggerClassName,
  items,
  footer,
}: {
  /** What the control is for, said to a screen reader. */
  label: string;
  /** What the control looks like. */
  trigger: ReactNode;
  triggerClassName: string;
  items: MenuItem[];
  /** Anything after the items, such as a date input. */
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // This menu is the topmost thing, so it takes the key: the sheet, which
      // is closed here, would have ignored it anyway.
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape, true);
    // Focus goes to the first item, so the keyboard can carry on from the
    // control that opened it.
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  function arrows(event: React.KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const entries = [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    entries[(next + entries.length) % entries.length]?.focus();
    event.preventDefault();
  }

  return (
    // `data-no-drag`: a press on the control or inside the menu must not start
    // dragging the row; see `mountDrag`.
    <span ref={root} className="row-menu" data-no-drag>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          // The row's body selects on click; this is not a click on the body.
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>

      {open && (
        <div
          id={menuId}
          className="dn-card row-menu__list"
          role="menu"
          aria-label={label}
          onKeyDown={arrows}
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className="dn-btn dn-btn--ghost dn-btn--sm row-menu__item"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              onClick={() => {
                item.onSelect();
                close(true);
              }}
            >
              {item.label}
            </button>
          ))}
          {footer?.(() => close(true))}
        </div>
      )}
    </span>
  );
}

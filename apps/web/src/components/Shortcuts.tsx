/**
 * The `?` sheet: the seven keys, and nothing else.
 *
 * Drawn from `SHORTCUTS`, the same table the tests walk, so what is listed here
 * is exactly what resolves. It is an ordinary `Sheet`, which means it is also
 * covered by the rule that no shortcut fires while a sheet is open — `?` does
 * not toggle it, Escape (the library's own) closes it.
 *
 * `.dn-kbd` is Diurnal's own key cap; there is no colour here and no class of
 * ours beyond the grid that lines the caps up.
 */

import { Sheet } from "../diurnal.js";
import { SHORTCUTS } from "../shortcuts.js";

export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} title="Keyboard shortcuts" onClose={onClose}>
      <h2 className="editor-title">Keyboard shortcuts</h2>

      <dl className="shortcuts">
        {SHORTCUTS.map((entry) => (
          <div className="shortcut" key={entry.label}>
            <dt className="shortcut-keys">
              {entry.keys.map((key) => (
                <kbd className="dn-kbd" key={key}>
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="shortcut-label">{entry.label}</dd>
          </div>
        ))}
      </dl>

      <p className="dn-hint">
        None of these act while you are typing in a field or while a panel is open.
      </p>

      <div className="editor-actions">
        <button className="dn-btn" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

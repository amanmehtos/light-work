/**
 * Preferences — the first settings surface in the app.
 *
 * One switch for now, and it is deliberately not a browser preference: it
 * governs whether a synced project is part of the account, so a phone that had
 * it off and a laptop that had it on would disagree about what the account
 * contains. It rides the same oplog as everything else.
 *
 * Off hides rather than deletes. A list of rewards you have earned is a record
 * of work already done; nothing else can recreate it, so a switch is not
 * allowed to throw it away.
 */

import type { Op } from "@light/core";
import type { Operations } from "@light/client-sdk";
import { Sheet } from "../diurnal.js";

export function Preferences({
  open,
  ops,
  commit,
  rewardsEnabled,
  onClose,
}: {
  open: boolean;
  ops: Operations;
  commit: (ops: Op[]) => void;
  rewardsEnabled: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} title="Preferences" onClose={onClose}>
      <h2 className="editor-title">Preferences</h2>

      {/* `.dn-check` rather than `.dn-switch`: the switch's knob is drawn by
          `fluid.mjs`, which builds its own track around the input — it would be
          rearranging DOM that React owns. The checkbox is pure CSS and needs
          no such bargain. */}
      <div className="preference">
        <label className="dn-check preference-toggle">
          <input
            type="checkbox"
            checked={rewardsEnabled}
            onChange={(event) => commit(ops.setRewardsEnabled(event.target.checked).ops)}
          />
          <span>Rewards</span>
        </label>
        <p className="dn-hint">
          Each task can name what finishing it earns. Completing the task files that reward in a
          Rewards project — a shelf of what the work bought you. Turning this off hides the field
          and the project; nothing already earned is deleted, and turning it back on brings the lot
          back.
        </p>
      </div>

      <div className="editor-actions">
        <button className="dn-btn" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

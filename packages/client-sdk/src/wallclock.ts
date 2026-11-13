/**
 * From a wall-clock time to an instant.
 *
 * The parser reads "tomorrow 9am" as a calendar day and `09:00`, with no zone,
 * because a line of text does not know where its writer is standing. A timed
 * `Due` is stored as a UTC instant, so something has to say whose nine o'clock
 * it is. In the browser that is the machine's own zone, which is what
 * `schedule.ts`'s `atTime` does; for an agent it is the zone the session was
 * told the account lives in. This is the one place that conversion is spelled
 * out, so the two cannot disagree about it.
 */

/** The wall clock in `zone` at an instant, read as though it were UTC. */
function wallAsUtc(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * The instant at which `day` shows `minutes` past midnight, in `zone`.
 *
 * With no zone it is the machine's local time. Returns null when the clock
 * never shows that time on that day — 02:30 on the night the clocks go
 * forward — because picking a neighbouring hour would be a guess about
 * exactly the thing this module exists to get right. An invalid zone throws.
 *
 * The zone's offset depends on the instant being asked about, which depends on
 * the offset. So it is solved by iteration: guess with the offset at the
 * wall-clock-as-UTC, then ask again at the answer. Two rounds settle it
 * everywhere except across the transition itself, which the final check
 * catches.
 */
export function instantAt(day: string, minutes: number, zone?: string): string | null {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number) as [number, number, number];

  if (zone === undefined) {
    const when = new Date(year, month - 1, date, 0, minutes, 0, 0);
    const holds =
      when.getFullYear() === year &&
      when.getMonth() === month - 1 &&
      when.getDate() === date &&
      when.getHours() * 60 + when.getMinutes() === minutes;
    return holds ? when.toISOString() : null;
  }

  const wanted = Date.UTC(year, month - 1, date, 0, minutes, 0, 0);
  let guess = wanted - (wallAsUtc(wanted, zone) - wanted);
  guess = wanted - (wallAsUtc(guess, zone) - guess);
  return wallAsUtc(guess, zone) === wanted ? new Date(guess).toISOString() : null;
}

/**
 * The wall clock at an instant, as `HH:MM`, in `zone` (the machine's when absent).
 *
 * What the parser's `now` is made from. In the same module as `instantAt`
 * because it is the same question asked the other way round.
 */
export function clockAt(instant: Date, zone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(zone === undefined ? {} : { timeZone: zone }),
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${get("hour")}:${get("minute")}`;
}

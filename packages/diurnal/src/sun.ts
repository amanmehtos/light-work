/**
 * Where the light is coming from.
 *
 * Diurnal's whole premise is that the page is a surface lit by a real light
 * source, and that the light moves as the day does. Everything else in the kit
 * is downstream of this file.
 *
 * Two models are available. The default needs nothing but the clock: the sun
 * rises in the east, arcs overhead, sets in the west, on a configurable
 * schedule. Given coordinates, it instead computes the real solar position, so
 * a user in Bangkok in December gets a low winter sun and long shadows while
 * someone in Reykjavík gets something stranger. The simple model is the default
 * because asking for location permission to decide a shadow angle would be a
 * poor trade.
 */

export interface SunOptions {
  /** Local hour the sun rises, when using the clock-only model. */
  sunriseHour?: number;
  /** Local hour the sun sets, when using the clock-only model. */
  sunsetHour?: number;
  /** Degrees north. Supplying both coordinates switches to real solar position. */
  latitude?: number;
  /** Degrees east. */
  longitude?: number;
}

export interface SunPosition {
  /**
   * Height above the horizon, 0 at the horizon and 1 at the zenith. Negative
   * below the horizon, which is what makes night distinguishable from dusk.
   */
  altitude: number;
  /**
   * Where the light sits horizontally, as the page sees it: -1 is full left
   * (sunrise, in the east), 0 is overhead, +1 is full right (sunset).
   */
  lateral: number;
  /** 0 at night through 1 in full daylight, easing through twilight. */
  daylight: number;
  /**
   * Colour of the light. +1 is the warm low sun of dawn and dusk, 0 is neutral
   * midday, -1 is the cool dimness of night.
   */
  warmth: number;
  /** True once the sun is below the horizon. */
  isNight: boolean;
  /** Which model produced this. */
  model: "clock" | "solar";
}

const DEFAULT_SUNRISE = 6;
const DEFAULT_SUNSET = 18;

/** Twilight band, in altitude units, over which day fades to night. */
const TWILIGHT = 0.12;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Local time as a fractional hour, e.g. 14.5 for half past two. */
export function hourOf(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/**
 * The clock-only model.
 *
 * A half-sine from sunrise to sunset: zero at both ends, one at solar noon.
 * It is not astronomy, but it is continuous, monotonic in the right places, and
 * needs no permission to compute.
 */
function clockModel(date: Date, options: SunOptions): SunPosition {
  const sunrise = options.sunriseHour ?? DEFAULT_SUNRISE;
  const sunset = options.sunsetHour ?? DEFAULT_SUNSET;
  const hour = hourOf(date);
  const dayLength = Math.max(sunset - sunrise, 0.0001);

  // Progress through the day, which runs below 0 before dawn and above 1 after
  // dusk — that overshoot is what gives night a position rather than a hole.
  const progress = (hour - sunrise) / dayLength;

  const altitude = Math.sin(progress * Math.PI);
  // Light tracks east to west regardless of whether it is up, so the night
  // side stays continuous with the day either side of it.
  const lateral = clamp(-Math.cos(clamp(progress, -0.5, 1.5) * Math.PI), -1, 1);

  return finish(altitude, lateral, "clock");
}

/* ------------------------------------------------------------------ */
/* Real solar position                                                */
/* ------------------------------------------------------------------ */

const RAD = Math.PI / 180;

/** Days since the J2000.0 epoch. */
function julianDays(date: Date): number {
  return date.getTime() / 86_400_000 - 10_957.5;
}

/**
 * Solar altitude and azimuth, following the standard low-precision algorithm
 * (Astronomical Almanac). Good to a fraction of a degree, which is far more
 * than a shadow angle needs.
 */
function solarModel(date: Date, latitude: number, longitude: number): SunPosition {
  const days = julianDays(date);

  const meanAnomaly = (357.5291 + 0.98560028 * days) * RAD;
  const eclipticLongitude =
    (280.459 + 0.98564736 * days) * RAD +
    1.915 * RAD * Math.sin(meanAnomaly) +
    0.02 * RAD * Math.sin(2 * meanAnomaly);

  const obliquity = (23.439 - 0.00000036 * days) * RAD;

  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

  // Greenwich mean sidereal time, then the local hour angle.
  const siderealTime = (280.16 + 360.9856235 * days) * RAD + longitude * RAD;
  const hourAngle = siderealTime - rightAscension;

  const lat = latitude * RAD;
  const sinAltitude =
    Math.sin(lat) * Math.sin(declination) +
    Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const altitudeAngle = Math.asin(clamp(sinAltitude, -1, 1));

  // Azimuth measured from due south, positive towards the west.
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat),
  );

  // Altitude normalised so that the zenith is 1, matching the clock model.
  const altitude = altitudeAngle / (Math.PI / 2);
  // East is page-left and west is page-right, as in the clock model.
  const lateral = clamp(Math.sin(azimuth), -1, 1);

  return finish(altitude, lateral, "solar");
}

/* ------------------------------------------------------------------ */

function finish(
  altitude: number,
  lateral: number,
  model: SunPosition["model"],
): SunPosition {
  const clampedAltitude = clamp(altitude, -1, 1);

  // Daylight eases across the twilight band rather than switching at the
  // horizon, so dusk is a gradient instead of a jump.
  const daylight = clamp((clampedAltitude + TWILIGHT) / (TWILIGHT * 2), 0, 1);

  // Warmth peaks when the sun is low but still up — golden hour — falls to
  // neutral at noon, and goes negative once it is down.
  const goldenness = clamp(1 - clamp(clampedAltitude, 0, 1) / 0.45, 0, 1);
  const warmth = clampedAltitude > 0 ? goldenness * daylight : -(1 - daylight);

  return {
    altitude: clampedAltitude,
    lateral,
    daylight,
    warmth: clamp(warmth, -1, 1),
    isNight: clampedAltitude <= 0,
    model,
  };
}

/** Where the light is, at a moment. */
export function sunPosition(date: Date = new Date(), options: SunOptions = {}): SunPosition {
  const { latitude, longitude } = options;
  if (latitude !== undefined && longitude !== undefined) {
    return solarModel(date, latitude, longitude);
  }
  return clockModel(date, options);
}

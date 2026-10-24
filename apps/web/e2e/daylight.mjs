/**
 * Captures the app under different skies.
 *
 * Diurnal's claim is that the light moves and the weather softens it, and that
 * is not something a unit test can confirm — it is either visible or it is
 * not. This drives the library's own `preview()` and `setWeather()` and shoots
 * the same screen for each, so a change to the lighting can be looked at
 * rather than argued about.
 *
 *   node e2e/daylight.mjs --out /some/dir
 *
 * Expects the same servers as smoke.mjs.
 */

const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.chromium !== undefined ? playwright : playwright.default;

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex === -1 ? "." : process.argv[outIndex + 1];

/** The day being shot; seeded tasks are due on it so "Today" has contents. */
const DAY = new Date().toISOString().slice(0, 10);

const SKIES = [
  { label: "07-00-sun-low", mode: "light", hour: 7, weather: "clear" },
  { label: "13-00-sun-high", mode: "light", hour: 13, weather: "clear" },
  { label: "13-00-overcast", mode: "light", hour: 13, weather: "overcast" },
  { label: "23-00-moon", mode: "dark", hour: 23, weather: "clear" },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 780 } });
const page = await context.newPage();

await page.goto(APP, { waitUntil: "networkidle" });
const email = `daylight-${Date.now()}@example.com`;
await page.getByLabel("Email").fill(email);
await page.getByRole("button", { name: "Send me a code" }).click();
const code = (await page.locator(".dev-code strong").textContent({ timeout: 10_000 })).trim();
await page.getByLabel("Six-digit code").fill(code);
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 15_000 });

const seed = [
  "Ready publisher pitch deck p1 @focus // lead with Indian-studio economics",
  "Send early-look build to Perp Games p2 @focus",
  "Night One + Two — fixing and testing p1",
  "Log wishlists @habit",
];
for (const line of seed) {
  await page.getByLabel("New task").fill(line);
  await page.getByLabel("Due date").fill(DAY);
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForTimeout(120);
}
await page.locator(".status", { hasText: "Synced" }).waitFor({ timeout: 15_000 });

for (const { label, mode, hour, weather } of SKIES) {
  const readout = await page.evaluate(
    ({ mode, hour, weather, day }) => {
      const api = globalThis.diurnal;
      api.setMode(mode);
      api.setWeather(weather);
      const when = new Date(`${day}T00:00:00`);
      when.setHours(hour, 0, 0, 0);
      const info = api.preview(when);
      const style = getComputedStyle(document.documentElement);
      return {
        body: info.source.body,
        alt: info.source.alt.toFixed(1),
        dx: style.getPropertyValue("--dn-dx").trim(),
        dy: style.getPropertyValue("--dn-dy").trim(),
        blur: style.getPropertyValue("--dn-blur").trim(),
        alpha: style.getPropertyValue("--dn-alpha").trim(),
        theme: document.documentElement.dataset.dnTheme,
      };
    },
    { mode, hour, weather, day: DAY },
  );

  // Give the theme crossfade and the shadow transition time to land.
  await page.waitForTimeout(700);

  console.log(
    `${label.padEnd(18)} ${readout.body.padEnd(5)} alt=${String(readout.alt).padStart(6)}` +
      `  shadow=(${readout.dx}, ${readout.dy})  blur=${readout.blur}  alpha=${readout.alpha}` +
      `  theme=${readout.theme}`,
  );

  await page.screenshot({ path: `${outDir}/diurnal-${label}.png` });
}

// Hand the page back to the real clock.
await page.evaluate(() => {
  globalThis.diurnal.preview(null);
  globalThis.diurnal.setWeather("live");
});

await browser.close();
console.log("done");

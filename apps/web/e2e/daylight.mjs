/**
 * Captures the app at several times of day.
 *
 * Diurnal's whole claim is that the light moves, and that is not something a
 * unit test can confirm — it is either visible or it is not. This fixes the
 * browser clock at a few hours and shoots the same screen at each, so a change
 * to the lighting model can be looked at rather than argued about.
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

/**
 * The day being shot. The seeded tasks are due on this date, not on the real
 * one — the browser clock is fixed here, so "today" in the app means this.
 */
const DAY = "2026-06-21";

const HOURS = [
  { label: "07-00-dawn", time: `${DAY}T07:00:00` },
  { label: "12-00-noon", time: `${DAY}T12:00:00` },
  { label: "17-30-dusk", time: `${DAY}T17:30:00` },
  { label: "23-00-night", time: `${DAY}T23:00:00` },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 760 } });
const page = await context.newPage();

// Sign in once; the session is in localStorage, so it survives the reloads.
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

for (const { label, time } of HOURS) {
  // Fixing the clock before the reload means the provider computes the sun for
  // that hour on first paint, rather than animating towards it.
  await page.clock.install({ time: new Date(time) });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);

  const readout = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      scheme: document.documentElement.dataset.dnScheme,
      shadowX: style.getPropertyValue("--dn-shadow-x").trim(),
      shadowY: style.getPropertyValue("--dn-shadow-y").trim(),
      length: style.getPropertyValue("--dn-shadow-length").trim(),
      daylight: style.getPropertyValue("--dn-daylight").trim(),
    };
  });
  console.log(
    `${label}  scheme=${readout.scheme}  shadow=(${readout.shadowX}, ${readout.shadowY})` +
      `  length=${readout.length}  daylight=${readout.daylight}`,
  );

  await page.screenshot({ path: `${outDir}/diurnal-${label}.png` });
}

await browser.close();
console.log("done");

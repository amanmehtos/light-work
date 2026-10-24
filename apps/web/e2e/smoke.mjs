/**
 * End-to-end smoke test.
 *
 * Drives the real app in a real browser against a real Worker, Durable Object
 * and D1. Unit tests cannot catch the things this does: that the token survives
 * a reload, that an optimistic write actually reached the server, that the
 * store's React wiring re-renders.
 *
 * Expects `wrangler dev` on 8787 with DEV_LOGIN=1 and `vite dev` on 5173.
 *
 *   node e2e/smoke.mjs [--screenshot path]
 *
 * Set PLAYWRIGHT_MODULE when Playwright lives outside the workspace, which is
 * the case on images that ship a browser already — ESM ignores NODE_PATH, and
 * installing a second copy here would not find the pre-installed browser.
 */

const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
// Playwright is CommonJS, so a dynamic import of a file path lands on .default.
const { chromium } = playwright.chromium !== undefined ? playwright : playwright.default;

const APP = process.env.APP_URL ?? "http://127.0.0.1:5173";
const screenshotPath = (() => {
  const index = process.argv.indexOf("--screenshot");
  return index === -1 ? null : process.argv[index + 1];
})();

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const email = `e2e-${Date.now()}@example.com`;

try {
  console.log("sign in");
  await page.goto(APP, { waitUntil: "networkidle" });
  check("the sign-in screen renders", await page.getByRole("heading", { name: "Light Week" }).isVisible());

  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();

  // Development mode shows the code rather than emailing it.
  const devCode = await page.locator(".dev-code strong").textContent({ timeout: 10_000 });
  check("a six-digit code is issued", /^\d{6}$/.test(devCode ?? ""), devCode ?? "none");

  await page.getByLabel("Six-digit code").fill(devCode.trim());
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 15_000 });
  check("the workspace loads after sign-in", true);
  check("the signed-in address is shown", (await page.textContent("body"))?.includes(email) === true);

  console.log("add a task");
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("New task").fill("Ready publisher pitch deck p1 @focus // lead with economics");
  await page.getByLabel("Due date").fill(today);
  await page.getByRole("button", { name: "Add" }).click();

  const row = page.locator(".task", { hasText: "Ready publisher pitch deck" });
  await row.waitFor({ timeout: 10_000 });
  check("the task appears immediately", await row.isVisible());

  const rowText = (await row.textContent()) ?? "";
  check("the p1 shorthand became a priority", rowText.includes("p1"), rowText);
  check("the @focus shorthand became a label", rowText.includes("@focus"), rowText);
  check("the shorthand is stripped from the title", !rowText.includes("p1 @focus"), rowText);
  check("the // text became a description", rowText.includes("lead with economics"), rowText);
  check("the due date shows as Today", rowText.includes("Today"), rowText);

  console.log("wait for sync");
  await page.locator(".status", { hasText: "Synced" }).waitFor({ timeout: 15_000 });
  check("the change reaches the server", true);

  console.log("reload");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 15_000 });
  check("the session survives a reload", true);

  const reloaded = page.locator(".task", { hasText: "Ready publisher pitch deck" });
  await reloaded.waitFor({ timeout: 15_000 });
  // This is the real assertion: the task came back from the Durable Object,
  // not from anything held in the page.
  check("the task comes back from the server", await reloaded.isVisible());
  const reloadedText = (await reloaded.textContent()) ?? "";
  check("its label survived the round trip", reloadedText.includes("@focus"), reloadedText);
  check("its priority survived the round trip", reloadedText.includes("p1"), reloadedText);

  console.log("projects");
  check(
    "a project was created to hold the first task",
    (await page.locator(".sidebar .nav-item", { hasText: "Inbox" }).count()) > 0,
  );

  console.log("add a second task and reorder");
  await page.getByLabel("New task").fill("Send early-look build to Perp Games");
  await page.getByLabel("Due date").fill(today);
  await page.getByRole("button", { name: "Add" }).click();
  await page.locator(".task", { hasText: "Perp Games" }).waitFor({ timeout: 10_000 });

  const titlesBefore = await page.locator(".task .title").allTextContents();
  check("both tasks are listed", titlesBefore.length === 2, titlesBefore.join(" | "));

  await page.getByRole("button", { name: /Move Send early-look build to Perp Games up/ }).click();
  const titlesAfter = await page.locator(".task .title").allTextContents();
  check(
    "reordering moves the task up",
    titlesAfter[0]?.includes("Perp Games") === true,
    titlesAfter.join(" | "),
  );

  if (screenshotPath !== null) {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`screenshot: ${screenshotPath}`);
  }

  console.log("complete a task");
  await page.locator(".status", { hasText: "Synced" }).waitFor({ timeout: 15_000 });
  await page.getByLabel("Complete Ready publisher pitch deck").click();

  // The Today view only shows open tasks, so completing removes it.
  await page
    .locator(".task", { hasText: "Ready publisher pitch deck" })
    .waitFor({ state: "detached", timeout: 10_000 });
  check("completing removes it from Today", true);

  // Every list view shows open work; finished tasks have their own view, which
  // is also where imported history lands.
  await page.getByRole("button", { name: "All tasks" }).click();
  check(
    "All tasks shows only open work",
    (await page.locator(".task", { hasText: "Ready publisher pitch deck" }).count()) === 0,
  );

  await page.getByRole("button", { name: "Completed" }).click();
  const done = page.locator(".task", { hasText: "Ready publisher pitch deck" });
  await done.waitFor({ timeout: 10_000 });
  check("the completed task is listed under Completed", await done.isVisible());
  check(
    "it is shown as struck through",
    (await page.locator(".task .title.done").count()) >= 1,
  );

  check("the page logged no errors", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (error) {
  failures += 1;
  console.log(`\nthrew: ${error instanceof Error ? error.message : String(error)}`);
  if (screenshotPath !== null) {
    await page.screenshot({ path: screenshotPath }).catch(() => {});
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

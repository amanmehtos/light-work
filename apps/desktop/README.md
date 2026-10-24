# Light Week for the desktop

A Tauri shell around the web app, so macOS, Windows and Linux all ship from one
codebase. Tauri rather than Electron because it uses the platform's own webview:
the bundle is single-digit megabytes instead of a hundred, which matters for
something people keep open all day.

Nothing here reimplements the app. The window loads `apps/web`, which is already
local-first — it keeps its own copy of the account and works offline — so the
shell's job is the window, the menu and the deep links, not the data.

## Building

Needs the Rust toolchain, plus `webkit2gtk` and `libayatana-appindicator` on
Linux. See https://tauri.app/start/prerequisites.

```sh
pnpm --filter @light/web build
pnpm --filter @light/desktop build
```

Development runs the Vite dev server behind the shell:

```sh
pnpm --filter @light/desktop dev
```

> **Not yet built or run.** This configuration was written but never compiled —
> the environment it was authored in has no macOS SDK and no webkit2gtk, so the
> first real build will likely need small corrections, particularly to the icon
> set, which is empty here.

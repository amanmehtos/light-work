/**
 * Pulls a full export straight from Todoist.
 *
 * One request with `sync_token: "*"` returns every active resource, which is the
 * highest-fidelity export available and the one the importer prefers. The token
 * is a personal API token from Todoist's integration settings.
 *
 * Completed tasks are not part of a full sync — Todoist keeps them behind a
 * separate paginated endpoint — so they are fetched separately and folded in.
 */

import type { SyncExport, SyncItem } from "./types.js";

const SYNC_URL = "https://api.todoist.com/api/v1/sync";
const COMPLETED_URL = "https://api.todoist.com/api/v1/tasks/completed";

const RESOURCE_TYPES = [
  "projects",
  "items",
  "sections",
  "labels",
  "notes",
  "filters",
  "reminders",
  "user",
];

export interface FetchOptions {
  token: string;
  /** Also pull completed tasks, which a full sync omits. Defaults to true. */
  includeCompleted?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export async function fetchSyncExport(options: FetchOptions): Promise<SyncExport> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const response = await doFetch(SYNC_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sync_token: "*", resource_types: RESOURCE_TYPES }),
  });

  if (!response.ok) {
    throw new Error(
      `Todoist sync failed: ${response.status} ${response.statusText}. ` +
        "Check the token has not been revoked.",
    );
  }

  const data = (await response.json()) as SyncExport;

  if (options.includeCompleted !== false) {
    const completed = await fetchCompleted(doFetch, options.token);
    data.items = [...(data.items ?? []), ...completed];
  }

  return data;
}

/** Walks the paginated completed-tasks endpoint until it runs out. */
async function fetchCompleted(doFetch: typeof fetch, token: string): Promise<SyncItem[]> {
  const items: SyncItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 500; page++) {
    const url = new URL(COMPLETED_URL);
    url.searchParams.set("limit", "200");
    if (cursor !== null) url.searchParams.set("cursor", cursor);

    const response = await doFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      // A missing or forbidden completed-tasks endpoint should not sink the
      // whole import; the active tasks are the valuable part.
      break;
    }

    const body = (await response.json()) as {
      items?: SyncItem[];
      next_cursor?: string | null;
    };
    for (const item of body.items ?? []) {
      items.push({ ...item, checked: true });
    }
    cursor = body.next_cursor ?? null;
    if (cursor === null) break;
  }

  return items;
}

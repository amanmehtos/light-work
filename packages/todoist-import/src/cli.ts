#!/usr/bin/env node
/**
 * Todoist -> Light Week import.
 *
 *   light-import-todoist --token <todoist-token> --out ops.json
 *   light-import-todoist --in export.json --out ops.json
 *   light-import-todoist --token <t> --push https://api.lightweek.app --auth <bearer>
 *
 * Writes a list of sync ops. Nothing is sent anywhere unless `--push` is given,
 * so the default is a dry run you can read before trusting it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fetchSyncExport } from "./fetch.js";
import { mapConnectorExport } from "./connector.js";
import { mapSyncExport } from "./map.js";
import { formatReport } from "./report.js";
import type { ConnectorExport, SyncExport } from "./types.js";

// Written as `| undefined` rather than optional so that assigning a possibly
// absent argv entry is allowed under exactOptionalPropertyTypes.
interface Args {
  token: string | undefined;
  in: string | undefined;
  out: string | undefined;
  push: string | undefined;
  auth: string | undefined;
  connector: boolean;
  skipCompleted: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    token: undefined,
    in: undefined,
    out: undefined,
    push: undefined,
    auth: undefined,
    connector: false,
    skipCompleted: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--token": args.token = argv[++i]; break;
      case "--in": args.in = argv[++i]; break;
      case "--out": args.out = argv[++i]; break;
      case "--push": args.push = argv[++i]; break;
      case "--auth": args.auth = argv[++i]; break;
      case "--connector": args.connector = true; break;
      case "--skip-completed": args.skipCompleted = true; break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (flag !== undefined && flag.startsWith("-")) {
          console.error(`Unknown flag: ${flag}\n`);
          console.error(USAGE);
          process.exit(2);
        }
    }
  }
  return args;
}

const USAGE = `Usage:
  light-import-todoist --token <todoist-api-token> [--out ops.json]
  light-import-todoist --in <export.json> [--connector] [--out ops.json]

Options:
  --token <t>        Todoist personal API token; pulls a full export directly.
  --in <file>        Read a previously saved export instead of fetching.
  --connector        Treat --in as the Todoist MCP connector's shape, not the Sync API's.
  --out <file>       Where to write the generated ops. Defaults to stdout summary only.
  --push <url>       POST the ops to a Light Week server instead of only writing them.
  --auth <bearer>    Bearer token for --push.
  --skip-completed   Do not fetch completed tasks (faster, loses history).

Get a token from Todoist: Settings -> Integrations -> Developer -> API token.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.token === undefined && args.in === undefined) {
    console.error("Need either --token or --in.\n");
    console.error(USAGE);
    process.exit(2);
  }

  let mapped;
  if (args.in !== undefined) {
    const raw = JSON.parse(await readFile(args.in, "utf8")) as unknown;
    mapped = args.connector
      ? mapConnectorExport(raw as ConnectorExport)
      : mapSyncExport(raw as SyncExport);
  } else {
    process.stderr.write("Fetching a full export from Todoist...\n");
    const data = await fetchSyncExport({
      token: args.token!,
      includeCompleted: !args.skipCompleted,
    });
    mapped = mapSyncExport(data);
  }

  console.log(formatReport(mapped.report));
  console.log(`\n${mapped.ops.length} ops generated.`);

  if (args.out !== undefined) {
    await writeFile(
      args.out,
      JSON.stringify({ ops: mapped.ops, idMap: mapped.idMap, report: mapped.report }, null, 2),
    );
    console.log(`Written to ${args.out}`);
  }

  if (args.push !== undefined) {
    if (args.auth === undefined) {
      console.error("--push needs --auth <bearer>.");
      process.exit(2);
    }
    // Pushed in batches so one oversized request cannot fail the whole import.
    const BATCH = 500;
    for (let i = 0; i < mapped.ops.length; i += BATCH) {
      const batch = mapped.ops.slice(i, i + BATCH);
      const response = await fetch(`${args.push.replace(/\/$/, "")}/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, since: 0, ops: batch }),
      });
      if (!response.ok) {
        console.error(`Push failed at op ${i}: ${response.status} ${await response.text()}`);
        process.exit(1);
      }
      process.stderr.write(`Pushed ${Math.min(i + BATCH, mapped.ops.length)}/${mapped.ops.length}\n`);
    }
    console.log("Push complete.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

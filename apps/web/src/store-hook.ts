/**
 * Wires the SDK's store and sync client into React.
 *
 * The store is the source of truth and lives outside React; the hook subscribes
 * to it and bumps a counter to re-render. That keeps the local-first model
 * intact — reads are synchronous against the store, not awaited promises — and
 * avoids mirroring the whole account into component state.
 */

import { LightStore, Operations, SyncClient, type SyncStatus } from "@light/client-sdk";
import { newNodeId, type Op } from "@light/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "./auth.js";

const NODE_KEY = "light-week.node";

/**
 * This device's identity, kept stable across reloads.
 *
 * It is the clock's node id, which breaks ties between devices, and the key the
 * client uses to ignore the echo of its own pushes. A fresh id every reload
 * would still be correct, but would make the tie-breaking arbitrary and the
 * echo filter useless.
 */
function deviceNode(): string {
  try {
    const existing = localStorage.getItem(NODE_KEY);
    if (existing !== null) return existing;
    const created = newNodeId();
    localStorage.setItem(NODE_KEY, created);
    return created;
  } catch {
    return newNodeId();
  }
}

export interface LightWeek {
  store: LightStore;
  ops: Operations;
  status: SyncStatus;
  /** Bumps on every store change; depend on it to re-render. */
  revision: number;
  /** Stages ops locally and queues them for sync. */
  commit: (ops: Op[]) => void;
  ready: boolean;
  error: string | null;
}

export function useLightWeek(token: string): LightWeek {
  const store = useMemo(() => new LightStore(deviceNode()), []);
  const ops = useMemo(() => new Operations(store), [store]);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SyncStatus>({ state: "syncing", pending: 0, cursor: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<SyncClient | null>(null);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setRevision((n) => n + 1));
    return unsubscribe;
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    const client = new SyncClient({
      baseUrl: API_BASE,
      token,
      store,
      onStatus: (next) => {
        if (!cancelled) setStatus(next);
      },
    });
    clientRef.current = client;

    client
      .start()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        client.connect();
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        // Still usable: the store may hold nothing, but the app should render
        // rather than hang on a spinner.
        setReady(true);
      });

    return () => {
      cancelled = true;
      client.disconnect();
      clientRef.current = null;
    };
  }, [store, token]);

  const commit = useCallback((staged: Op[]) => {
    if (staged.length === 0) return;
    clientRef.current?.enqueue(staged);
  }, []);

  return { store, ops, status, revision, commit, ready, error };
}

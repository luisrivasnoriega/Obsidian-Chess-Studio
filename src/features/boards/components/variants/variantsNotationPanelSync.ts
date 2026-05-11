import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TreeStore, TreeStoreState } from "@/state/store/tree";
import type { TreeState } from "@/utils/treeReducer";

const SYNC_EVENT = "variants-notation-panel-sync";
const REQUEST_EVENT = "variants-notation-panel-request";

type SyncMode = "owner" | "client";

type SyncPayload = {
  tabId: string;
  sourceId: string;
  state: TreeState;
};

type RequestPayload = {
  tabId: string;
  sourceId: string;
};

function createSourceId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function canUseTauriEvents() {
  return typeof window !== "undefined" && window.__TAURI__ !== undefined;
}

function toTreeState(state: TreeStoreState): TreeState {
  return {
    root: state.root,
    headers: state.headers,
    position: [...state.position],
    dirty: state.dirty,
    report: state.report,
  };
}

function syncSignature(state: TreeStoreState) {
  return [state.saveVersion, state.position.join("."), state.dirty ? "1" : "0"].join("|");
}

function isTreeState(value: unknown): value is TreeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TreeState>;
  return (
    !!candidate.root && !!candidate.headers && Array.isArray(candidate.position) && typeof candidate.dirty === "boolean"
  );
}

export function useVariantsNotationPanelSync({
  enabled = true,
  mode,
  store,
  tabId,
}: {
  enabled?: boolean;
  mode: SyncMode;
  store: TreeStore;
  tabId: string | null | undefined;
}) {
  const sourceId = useMemo(createSourceId, []);
  const applyingRemoteStateRef = useRef(false);
  const lastSignatureRef = useRef("");
  const emitTimerRef = useRef<number | null>(null);

  const emitSnapshot = useCallback(
    (nextTabId = tabId) => {
      if (!enabled || !nextTabId || !canUseTauriEvents()) return;
      const state = store.getState();
      lastSignatureRef.current = syncSignature(state);
      void emit<SyncPayload>(SYNC_EVENT, {
        tabId: nextTabId,
        sourceId,
        state: toTreeState(state),
      });
    },
    [enabled, sourceId, store, tabId],
  );

  const queueSnapshot = useCallback(() => {
    if (emitTimerRef.current != null) {
      window.clearTimeout(emitTimerRef.current);
    }
    emitTimerRef.current = window.setTimeout(() => {
      emitTimerRef.current = null;
      emitSnapshot();
    }, 40);
  }, [emitSnapshot]);

  useEffect(() => {
    if (!enabled || !tabId || !canUseTauriEvents()) return;
    lastSignatureRef.current = syncSignature(store.getState());

    const unsubscribe = store.subscribe((state) => {
      if (applyingRemoteStateRef.current) return;
      const signature = syncSignature(state);
      if (signature === lastSignatureRef.current) return;
      lastSignatureRef.current = signature;
      queueSnapshot();
    });

    return () => {
      unsubscribe();
      if (emitTimerRef.current != null) {
        window.clearTimeout(emitTimerRef.current);
        emitTimerRef.current = null;
      }
    };
  }, [enabled, queueSnapshot, store, tabId]);

  useEffect(() => {
    if (!enabled || !tabId || !canUseTauriEvents()) return;

    let disposed = false;
    const unlisten = listen<SyncPayload>(SYNC_EVENT, (event) => {
      if (disposed) return;
      const payload = event.payload;
      if (!payload || payload.tabId !== tabId || payload.sourceId === sourceId || !isTreeState(payload.state)) return;

      applyingRemoteStateRef.current = true;
      store.getState().setState(payload.state);
      applyingRemoteStateRef.current = false;
      lastSignatureRef.current = syncSignature(store.getState());

      if (mode === "owner") {
        emitSnapshot(tabId);
      }
    });

    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, [emitSnapshot, enabled, mode, sourceId, store, tabId]);

  useEffect(() => {
    if (!enabled || !tabId || !canUseTauriEvents()) return;

    if (mode === "client") {
      void emit<RequestPayload>(REQUEST_EVENT, { tabId, sourceId });
      return;
    }

    let disposed = false;
    const unlisten = listen<RequestPayload>(REQUEST_EVENT, (event) => {
      if (disposed) return;
      const payload = event.payload;
      if (!payload || payload.tabId !== tabId || payload.sourceId === sourceId) return;
      emitSnapshot(payload.tabId);
    });

    emitSnapshot(tabId);

    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, [emitSnapshot, enabled, mode, sourceId, tabId]);
}

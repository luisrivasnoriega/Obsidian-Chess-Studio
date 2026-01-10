import { useCallback, useEffect, useState } from "react";

type Options = {
  delayMs?: number;
  onRetry?: () => void;
};

/**
 * Small helper to keep the existing "simulate initialization time for smooth UX" behavior,
 * while guaranteeing proper cleanup on unmount.
 */
export function useSimulatedInit(options: Options = {}) {
  const { delayMs = 50, onRetry } = options;

  const [runId, setRunId] = useState(0);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initializationError, setInitializationError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    setIsInitializing(true);
    setInitializationError(null);

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setIsInitializing(false);
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delayMs, runId]);

  const retry = useCallback(() => {
    setInitializationError(null);
    setRunId((v) => v + 1);
    onRetry?.();
  }, [onRetry]);

  return { isInitializing, initializationError, retry, setInitializationError };
}


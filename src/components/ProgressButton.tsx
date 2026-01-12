import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

import { memo, useEffect, useState } from "react";
import ProgressButtonWithOutState from "./ProgressButtonWithOutState";

type Payload = {
  id: string;
  progress: number;
  finished: boolean;
};

type Props<T> = {
  id: string;
  initInstalled: boolean;
  progressEvent: { listen: (handler: EventCallback<T>) => Promise<UnlistenFn> };
  onClick: (id: string) => void;
  leftIcon?: React.ReactNode;
  completeOnFinished?: boolean;
  stopInProgressOnFinished?: boolean;
  labels: {
    completed: string;
    action: string;
    inProgress: string;
    finalizing?: string;
  };
  disabled?: boolean;
  redoable?: boolean;
  inProgress: boolean;
  setInProgress: (inProgress: boolean) => void;
};

function ProgressButton<T extends Payload>({
  id,
  initInstalled,
  progressEvent,
  onClick,
  leftIcon,
  completeOnFinished = true,
  stopInProgressOnFinished = true,
  labels,
  disabled,
  redoable,
  inProgress,
  setInProgress,
}: Props<T>) {
  const [progress, setProgress] = useState(0);
  const [completed, setCompleted] = useState(initInstalled);

  useEffect(() => {
    setCompleted(initInstalled);
  }, [initInstalled]);

  useEffect(() => {
    const unlisten = progressEvent.listen(async ({ payload }) => {
      if (payload.id !== id) return;
      if (payload.finished) {
        if (stopInProgressOnFinished) setInProgress(false);
        if (completeOnFinished) setCompleted(true);
        setProgress(0);
      } else {
        setProgress(payload.progress);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [completeOnFinished, id, progressEvent, setInProgress, stopInProgressOnFinished]);

  return (
    <ProgressButtonWithOutState
      id={id}
      onClick={onClick}
      leftIcon={leftIcon}
      labels={labels}
      disabled={disabled}
      redoable={redoable}
      inProgress={inProgress}
      progress={progress}
      completed={completed}
    />
  );
}

export default memo(ProgressButton);

import type { ReactNode } from "react";
import { PanelLoadingState } from "./PanelLoadingState";

type PanelLoadGateProps = {
  isLoading?: boolean;
  isFetching?: boolean;
  hasData: boolean;
  message?: string;
  children: ReactNode;
};

/**
 * Homogenized loader behavior for PersonalCard panels:
 * - While loading with NO data: show a centered loader (blocking).
 * - While fetching WITH data: show a small banner but keep rendering the content (non-blocking).
 */
export function PanelLoadGate({
  isLoading = false,
  isFetching = false,
  hasData,
  message,
  children,
}: PanelLoadGateProps) {
  const visible = isLoading || isFetching;

  if (visible && !hasData) {
    return <PanelLoadingState isLoading={isLoading} isFetching={isFetching} hasData={false} message={message} />;
  }

  return (
    <>
      {visible && <PanelLoadingState isLoading={isLoading} isFetching={isFetching} hasData={true} message={message} />}
      {children}
    </>
  );
}

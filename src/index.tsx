import { createRoot } from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./i18n";

const container = document.getElementById("app") as HTMLElement;
const root = createRoot(container, {
  onCaughtError: (error, errorInfo) => {
    const message = String((error as any)?.message ?? error);
    const componentStack = errorInfo.componentStack ?? "";
    const boundaryName = (errorInfo.errorBoundary as any)?.constructor?.name ?? "unknown";
    const details = [
      `Message: ${message}`,
      `Error boundary: ${boundaryName}`,
      componentStack ? "" : "",
      componentStack ? "Component stack:" : "",
      componentStack ? componentStack.trim() : "",
    ]
      .filter((l) => l !== "")
      .join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: attach debug data to window for easier copy/paste.
    (window as any).__ocsLastErrorDetails = details;
    // biome-ignore lint/suspicious/noConsole: this is for debugging a crash loop.
    console.error(details);
  },
  onUncaughtError: (error, errorInfo) => {
    const message = String((error as any)?.message ?? error);
    const componentStack = errorInfo.componentStack ?? "";
    const details = [
      `Message: ${message}`,
      componentStack ? "" : "",
      componentStack ? "Component stack:" : "",
      componentStack ? componentStack.trim() : "",
    ]
      .filter((l) => l !== "")
      .join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: attach debug data to window for easier copy/paste.
    (window as any).__ocsLastErrorDetails = details;
    // biome-ignore lint/suspicious/noConsole: this is for debugging a crash loop.
    console.error(details);
  },
});
root.render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);

import "@testing-library/jest-dom";

// Mock window.matchMedia for Mantine components
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// Polyfill ResizeObserver for Mantine components in JSDOM
if (typeof globalThis.ResizeObserver === "undefined") {
  const ResizeObserverMock = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = ResizeObserverMock as any;
  // Also set on window for JSDOM compatibility
  if (typeof window !== "undefined") {
    (window as any).ResizeObserver = ResizeObserverMock;
  }
}


import "@testing-library/jest-dom";
import React from "react";
import { vi } from "vitest";

// -----------------------------
// Global Tauri mocks (unit tests run in JSDOM, not in a Tauri runtime)
// -----------------------------

// -----------------------------
// Global TanStack Router mocks
// Many pages/components import Route objects or Link/hooks; in unit tests we
// don't mount a RouterProvider, so we provide safe stubs.
// -----------------------------
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();

  // biome-ignore lint/suspicious/noExplicitAny: Mock route object for tests
  const makeRoute = (): any => {
    const route = {
      useSearch: () => ({}),
      useLoaderData: () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: Mock config parameter
      update: (_config: any) => makeRoute(),
      // biome-ignore lint/suspicious/noExplicitAny: Mock children parameter
      _addFileChildren: (_children: any) => makeRoute(),
      // biome-ignore lint/suspicious/noExplicitAny: Mock types parameter
      _addFileTypes: (_types: any) => makeRoute(),
      // biome-ignore lint/suspicious/noExplicitAny: Mock children parameter
      addChildren: (_children: any) => makeRoute(),
      init: vi.fn(),
      id: "",
      path: "",
      getParentRoute: () => null,
    };
    return route;
  };

  return {
    ...actual,
    // Basic navigation hooks
    useNavigate: () => vi.fn(),
    // Common data hooks
    useLoaderData: () => ({}),
    useSearch: () => ({}),
    useMatch: () => ({ id: "", pathname: "", params: {} }),
    useRouterState: () => ({}),
    useRouter: () => ({
      navigate: vi.fn(),
      buildLocation: vi.fn(),
      state: { location: { pathname: "", search: {} } },
    }),

    // Link is used in a few views; keep it inert
    // biome-ignore lint/suspicious/noExplicitAny: Mock Link props for tests
    Link: ({ children, to, ...rest }: any) =>
      React.createElement("a", { href: typeof to === "string" ? to : "#", ...rest }, children),

    // Route factory helpers used by our file-routes
    // createFileRoute returns a function that returns a Route object with update method
    createFileRoute: () => () => makeRoute(),
    createRootRouteWithContext: () => () => makeRoute(),

    // Route class with static update method (used by routeTree.gen.ts)
    // biome-ignore lint/complexity/noStaticOnlyClass: Required by TanStack Router mock
    Route: class Route {
      // biome-ignore lint/suspicious/noExplicitAny: Mock config parameter
      static update(config: any) {
        return {
          ...config,
          init: vi.fn(),
          // biome-ignore lint/suspicious/noExplicitAny: Mock function context and parameter
          _addFileChildren: vi.fn(function (this: any, children: any) {
            return { ...this, children };
          }),
          // biome-ignore lint/suspicious/noExplicitAny: Mock function context and parameter
          _addFileTypes: vi.fn(function (this: any, types: any) {
            return { ...this, types };
          }),
        };
      }
    },
  };
});

// Core invoke bridge
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  // Some components use this for images
  convertFileSrc: (path: string) => `tauri://${path}`,
}));

// Event system (used by generated bindings' events.*.listen)
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  once: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Path helpers (many utilities call these; real impl calls invoke)
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn().mockResolvedValue("C:\\mock\\AppData"),
  documentDir: vi.fn().mockResolvedValue("C:\\mock\\Documents"),
  homeDir: vi.fn().mockResolvedValue("C:\\mock\\Home"),
  resolve: vi.fn(async (...parts: string[]) => parts.filter(Boolean).join("\\")),
  join: vi.fn(async (...parts: string[]) => parts.filter(Boolean).join("\\")),
}));

// Plugin log (real impl calls invoke)
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  debug: vi.fn().mockResolvedValue(undefined),
  trace: vi.fn().mockResolvedValue(undefined),
}));

// FS plugin (keep minimal defaults; tests can override)
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: {
    AppData: "AppData",
    Document: "Document",
    Home: "Home",
  },
  exists: vi.fn().mockResolvedValue(false),
  readTextFile: vi.fn().mockResolvedValue(""),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}));

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
  // biome-ignore lint/suspicious/noExplicitAny: Mock ResizeObserver for JSDOM
  globalThis.ResizeObserver = ResizeObserverMock as any;
  // Also set on window for JSDOM compatibility
  if (typeof window !== "undefined") {
    // biome-ignore lint/suspicious/noExplicitAny: Mock ResizeObserver for JSDOM
    (window as any).ResizeObserver = ResizeObserverMock;
  }
}

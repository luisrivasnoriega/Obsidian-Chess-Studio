import { createTheme, DirectionProvider, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";

// Mock react-i18next before importing i18n
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    initReactI18next: {
      type: "languageDetector",
      init: vi.fn(),
    },
  };
});

// Mock @tanstack/react-router
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

// Mock jotai with stable references to prevent infinite loops
const stableEmptyArray: any[] = [];
const stableSetter = vi.fn();

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    // Always return the same array reference to prevent re-renders
    useAtom: () => [stableEmptyArray, stableSetter],
    useAtomValue: () => stableEmptyArray,
    useSetAtom: () => stableSetter,
  };
});

// Mock zustand
vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    useStore: () => ({}),
  };
});

// Mock @tauri-apps/plugin-fs
vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/plugin-fs")>();
  return {
    ...actual,
    exists: vi.fn().mockResolvedValue(false),
  };
});

// Mock @/utils/format
vi.mock("@/utils/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/format")>();
  return {
    ...actual,
    parseDate: vi.fn(),
    formatDateToPGN: vi.fn(),
  };
});

// Mock @/utils/engines
vi.mock("@/utils/engines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/engines")>();
  return {
    ...actual,
    requiredEngineSettings: [],
  };
});

// Mock @/utils/tabs
vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(),
  };
});

// Mock @/features/files/utils/file
vi.mock("@/features/files/utils/file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/files/utils/file")>();
  return {
    ...actual,
    processEntriesRecursively: vi.fn().mockResolvedValue([]),
  };
});

import i18n from "@/i18n";

// Create a minimal theme for testing
const testTheme = createTheme({});

// Ensure i18n is initialized for tests
if (!i18n.isInitialized) {
  i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    resources: {
      "en-US": {
        translation: {},
        language: {},
      },
    },
    interpolation: {
      escapeValue: false,
    },
  });
}

// Create a test wrapper with all necessary providers
function AllTheProviders({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <DirectionProvider>
        <MantineProvider theme={testTheme} defaultColorScheme="light">
          <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
        </MantineProvider>
      </DirectionProvider>
    </QueryClientProvider>
  );
}

// Custom render function that includes all providers
function customRender(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: AllTheProviders, ...options });
}

// Re-export everything from @testing-library/react
export * from "@testing-library/react";
export { customRender as render };

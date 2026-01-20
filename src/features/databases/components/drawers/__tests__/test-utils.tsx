import { createTheme, DirectionProvider, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

// Mock i18n completely to avoid initialization issues
vi.mock("@/i18n", () => {
  const i18nMock = {
    language: "en-US",
    languages: ["en-US"],
    isInitialized: true,
    changeLanguage: vi.fn().mockResolvedValue("en-US"),
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
    exists: vi.fn().mockReturnValue(true),
    getFixedT: vi.fn().mockReturnValue((key: string) => key),
    hasResourceBundle: vi.fn().mockReturnValue(true),
    getResourceBundle: vi.fn().mockReturnValue({}),
    addResourceBundle: vi.fn(),
    removeResourceBundle: vi.fn(),
    loadNamespaces: vi.fn().mockResolvedValue(undefined),
    loadLanguages: vi.fn().mockResolvedValue(undefined),
    reloadResources: vi.fn().mockResolvedValue(undefined),
    use: vi.fn().mockReturnThis(),
    init: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    dir: vi.fn().mockReturnValue("ltr"),
    services: {
      formatter: {
        add: vi.fn(),
        format: vi.fn().mockImplementation((value) => String(value)),
      },
    },
  };
  return {
    default: i18nMock,
  };
});

// Mock react-i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
    i18n: {
      language: "en-US",
      changeLanguage: vi.fn().mockResolvedValue("en-US"),
    },
  }),
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: {
    type: "languageDetector",
    init: vi.fn(),
  },
}));

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

// Create a minimal theme for testing
const testTheme = createTheme({});

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
          {children}
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

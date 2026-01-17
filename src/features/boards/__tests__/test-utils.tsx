import { createTheme, DirectionProvider, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render as rtlRender } from "@testing-library/react";
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
      <MantineProvider theme={testTheme}>
        <DirectionProvider>
          <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
        </DirectionProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

// Custom render function that includes all providers
export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, { wrapper: AllTheProviders, ...options });
}

export * from "@testing-library/react";

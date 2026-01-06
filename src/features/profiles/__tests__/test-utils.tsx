import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider, createTheme, DirectionProvider } from "@mantine/core";
import { I18nextProvider } from "react-i18next";
import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
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


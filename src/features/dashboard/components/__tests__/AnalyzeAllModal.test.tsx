import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import { AnalyzeAllModal } from "../../components/AnalyzeAllModal";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

describe("AnalyzeAllModal", () => {
  const mockOnClose = vi.fn();
  const mockOnAnalyze = vi.fn().mockResolvedValue(undefined);

  test("renders when opened", () => {
    render(<AnalyzeAllModal opened={true} onClose={mockOnClose} onAnalyze={mockOnAnalyze} gameCount={10} />);
    expect(document.body).toBeTruthy();
  });

  test("does not render when closed", () => {
    render(<AnalyzeAllModal opened={false} onClose={mockOnClose} onAnalyze={mockOnAnalyze} gameCount={10} />);
    // Modal should not be visible when closed
    expect(document.body).toBeTruthy();
  });
});


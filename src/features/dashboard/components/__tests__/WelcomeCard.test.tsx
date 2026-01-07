import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import userEvent from "@testing-library/user-event";
import { WelcomeCard } from "../../components/WelcomeCard";

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

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: () => "default",
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `tauri://${path}`,
}));

describe("WelcomeCard", () => {
  const mockOnPlayChess = vi.fn();
  const mockOnImportGame = vi.fn();

  test("renders without crashing", () => {
    render(
      <WelcomeCard
        isFirstOpen={false}
        onPlayChess={mockOnPlayChess}
        onImportGame={mockOnImportGame}
      />
    );
    expect(document.body).toBeTruthy();
  });

  test("calls onPlayChess when play button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <WelcomeCard
        isFirstOpen={false}
        onPlayChess={mockOnPlayChess}
        onImportGame={mockOnImportGame}
      />
    );
    const playButton = screen.getByRole("button", { name: /play/i });
    await user.click(playButton);
    expect(mockOnPlayChess).toHaveBeenCalled();
  });

  test("calls onImportGame when import button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <WelcomeCard
        isFirstOpen={false}
        onPlayChess={mockOnPlayChess}
        onImportGame={mockOnImportGame}
      />
    );
    const importButton = screen.getByRole("button", { name: /import/i });
    await user.click(importButton);
    expect(mockOnImportGame).toHaveBeenCalled();
  });

  test("displays player first name when provided", () => {
    render(
      <WelcomeCard
        isFirstOpen={false}
        onPlayChess={mockOnPlayChess}
        onImportGame={mockOnImportGame}
        playerFirstName="John"
      />
    );
    expect(screen.getByText(/john/i)).toBeInTheDocument();
  });

  test("displays FIDE title when provided", () => {
    render(
      <WelcomeCard
        isFirstOpen={false}
        onPlayChess={mockOnPlayChess}
        onImportGame={mockOnImportGame}
        fideInfo={{ title: "GM", standardRating: 2500 }}
      />
    );
    expect(screen.getByText(/gm/i)).toBeInTheDocument();
  });
});


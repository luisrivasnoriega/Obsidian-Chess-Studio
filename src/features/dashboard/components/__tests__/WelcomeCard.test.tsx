import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { WelcomeCard } from "../../components/WelcomeCard";
import { render, screen } from "./test-utils";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; [key: string]: unknown }) => {
      if (options?.defaultValue) {
        return options.defaultValue;
      }
      // Handle interpolation for welcome messages
      if (key.includes("backWithName") && options?.name) {
        return `Welcome back, ${options.name}!`;
      }
      return key;
    },
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

  test("renders without crashing", () => {
    render(<WelcomeCard isFirstOpen={false} onPlayChess={mockOnPlayChess} />);
    expect(document.body).toBeTruthy();
  });

  test("calls onPlayChess when play button is clicked", async () => {
    const user = userEvent.setup();
    render(<WelcomeCard isFirstOpen={false} onPlayChess={mockOnPlayChess} />);
    const playButton = screen.getByRole("button", { name: /play/i });
    await user.click(playButton);
    expect(mockOnPlayChess).toHaveBeenCalled();
  });

  test("displays player first name when provided", () => {
    render(<WelcomeCard isFirstOpen={false} onPlayChess={mockOnPlayChess} playerFirstName="John" />);
    expect(screen.getByText(/john/i)).toBeInTheDocument();
  });

  test("displays FIDE title when provided", () => {
    render(
      <WelcomeCard
        isFirstOpen={false}
        onPlayChess={mockOnPlayChess}
        fideInfo={{ title: "GM", standardRating: 2500 }}
      />,
    );
    expect(screen.getByText(/gm/i)).toBeInTheDocument();
  });
});

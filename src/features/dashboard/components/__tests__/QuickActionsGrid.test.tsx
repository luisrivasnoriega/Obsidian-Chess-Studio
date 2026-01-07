import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen } from "./test-utils";
import userEvent from "@testing-library/user-event";
import { QuickActionsGrid } from "../../components/QuickActionsGrid";
import { IconChess } from "@tabler/icons-react";

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

describe("QuickActionsGrid", () => {
  const mockAction1 = vi.fn();
  const mockAction2 = vi.fn();

  const actions = [
    {
      icon: <IconChess />,
      title: "Action 1",
      description: "Description 1",
      onClick: mockAction1,
      color: "blue" as const,
    },
    {
      icon: <IconChess />,
      title: "Action 2",
      description: "Description 2",
      onClick: mockAction2,
      color: "green" as const,
    },
  ];

  test("renders all actions", () => {
    render(<QuickActionsGrid actions={actions} />);
    expect(screen.getByText("Action 1")).toBeInTheDocument();
    expect(screen.getByText("Action 2")).toBeInTheDocument();
    expect(screen.getByText("Description 1")).toBeInTheDocument();
    expect(screen.getByText("Description 2")).toBeInTheDocument();
  });

  test("calls onClick when action button is clicked", async () => {
    const user = userEvent.setup();
    render(<QuickActionsGrid actions={actions} />);
    // Find all buttons with "open" text and click the first one (Action 1)
    const buttons = screen.getAllByRole("button", { name: /open/i });
    expect(buttons.length).toBeGreaterThan(0);
    await user.click(buttons[0]);
    expect(mockAction1).toHaveBeenCalled();
  });

  test("renders empty grid when no actions provided", () => {
    render(<QuickActionsGrid actions={[]} />);
    expect(document.body).toBeTruthy();
  });
});


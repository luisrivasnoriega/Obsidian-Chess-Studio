import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "./test-utils";
import { AddProfileAccountModal } from "../components/modals/AddProfileAccountModal";

// Mantine Modal / Select can rely on ResizeObserver in JSDOM
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

vi.mock("@/components/GenericCard", () => ({
  __esModule: true,
  default: ({ id, isSelected, setSelected, content }: any) => (
    <button type="button" data-testid={`generic-card-${id}`} aria-pressed={isSelected} onClick={setSelected}>
      {content}
    </button>
  ),
}));

describe("AddProfileAccountModal", () => {
  test("submits lichess payload and closes", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onClose = vi.fn();

    render(
      <AddProfileAccountModal
        opened
        onClose={onClose}
        profiles={[{ id: "p1", name: "P1", createdAt: 0, updatedAt: 0 } as any]}
        defaultProfileId="p1"
        onAdd={onAdd}
      />,
    );

    // Fill username
    await user.type(screen.getByLabelText(/username/i), "SomeUser");

    // Toggle "Login with browser" (lichess only)
    const checkbox = screen.getByLabelText(/login with browser/i);
    await user.click(checkbox);

    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(onAdd).toHaveBeenCalledWith({
      profileId: "p1",
      website: "lichess",
      username: "SomeUser",
      withLogin: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  test("submits chesscom payload with withLogin=false", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onClose = vi.fn();

    render(
      <AddProfileAccountModal
        opened
        onClose={onClose}
        profiles={[{ id: "p1", name: "P1", createdAt: 0, updatedAt: 0 } as any]}
        defaultProfileId="p1"
        onAdd={onAdd}
      />,
    );

    // Switch to chesscom
    await user.click(screen.getByTestId("generic-card-chesscom"));

    await user.type(screen.getByLabelText(/username/i), "CCUser");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(onAdd).toHaveBeenCalledWith({
      profileId: "p1",
      website: "chesscom",
      username: "CCUser",
      withLogin: false,
    });
  });
});



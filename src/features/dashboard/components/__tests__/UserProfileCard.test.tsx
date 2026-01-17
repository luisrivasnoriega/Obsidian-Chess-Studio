import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { UserProfileCard } from "../../components/UserProfileCard";
import { render, screen } from "./test-utils";

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

vi.mock("../../components/EditProfileModal", () => ({
  EditProfileModal: ({ opened, onClose }: { opened: boolean; onClose: () => void }) =>
    opened ? <div data-testid="edit-modal">Edit Modal</div> : null,
}));

vi.mock("@/features/profiles/components/LichessLogo", () => ({
  default: () => <div data-testid="lichess-logo">Lichess Logo</div>,
}));

describe("UserProfileCard", () => {
  const mockOnFideUpdate = vi.fn();
  const ratingHistory = {
    classical: 2000,
    rapid: 1900,
    blitz: 1800,
    bullet: 1700,
  };

  test("renders user profile information", () => {
    render(<UserProfileCard name="Test Player" handle="testplayer" title="Expert" ratingHistory={ratingHistory} />);
    expect(screen.getByText("Test Player")).toBeInTheDocument();
  });

  test("opens edit modal when edit button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <UserProfileCard
        name="Test Player"
        handle="testplayer"
        title="Expert"
        ratingHistory={ratingHistory}
        onFideUpdate={mockOnFideUpdate}
      />,
    );
    const editButton = screen.getByRole("button");
    await user.click(editButton);
    expect(screen.getByTestId("edit-modal")).toBeInTheDocument();
  });

  test("displays custom name when provided", () => {
    render(
      <UserProfileCard
        name="Original Name"
        handle="testplayer"
        title="Expert"
        ratingHistory={ratingHistory}
        customName="Custom Name"
      />,
    );
    expect(screen.getByText("Custom Name")).toBeInTheDocument();
  });

  test("displays FIDE title when provided", () => {
    render(
      <UserProfileCard
        name="Test Player"
        handle="testplayer"
        title="Expert"
        ratingHistory={ratingHistory}
        fidePlayer={{ name: "Test", firstName: "Test", gender: "male", title: "GM" }}
      />,
    );
    expect(screen.getByText(/gm/i)).toBeInTheDocument();
  });
});

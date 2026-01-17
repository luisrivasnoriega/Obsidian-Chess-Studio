import { beforeAll, describe, expect, test, vi } from "vitest";
import FileGridView from "../../views/FileGridView";
import { render } from "./test-utils";

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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [[], vi.fn()],
    useSetAtom: () => vi.fn(),
    atomWithStorage: () => ({ init: vi.fn() }),
  };
});

vi.mock("@/components/GenericCard", () => ({
  default: () => <div>GenericCard</div>,
}));

vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: vi.fn(),
  };
});

vi.mock("@/utils/unwrap", () => ({
  unwrap: (r: any) => (r?.status === "ok" ? r.data : null),
}));

describe("FileGridView", () => {
  test("renders without crashing", () => {
    render(
      <FileGridView
        files={[]}
        isLoading={false}
        selectedFile={null}
        setSelectedFile={vi.fn()}
        search=""
        filter=""
        gridCols={3}
      />,
    );
    expect(document.body).toBeTruthy();
  });
});

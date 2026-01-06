import React from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "./test-utils";
import WebsiteAccountSelector from "../components/PersonalCardPanels/WebsiteAccountSelector";
import type { Session } from "@/utils/session";

// Mantine Select / Popover can rely on ResizeObserver in JSDOM
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

// Mock jotai to provide sessions
let mockSessions: Session[] = [];

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: (atom: any) => {
      // This component only uses sessionsAtom, so we can safely return mockSessions
      // If we need to support other atoms in the future, we can add identification logic
      return mockSessions;
    },
  };
});

describe("WebsiteAccountSelector", () => {
  test("renders website selector and calls handlers", async () => {
    mockSessions = [
      {
        player: "Test Player",
        profileId: "p1",
        updatedAt: Date.now(),
        createdAt: Date.now(),
        chessCom: { username: "cc_user", stats: null as any },
      } as any,
      {
        player: "Test Player",
        profileId: "p1",
        updatedAt: Date.now(),
        createdAt: Date.now(),
        lichess: { username: "li_user", accessToken: "t", account: null as any },
      } as any,
    ];

    const onWebsiteChange = vi.fn();
    const onAccountChange = vi.fn();

    render(
      <WebsiteAccountSelector
        playerName="Test Player"
        onWebsiteChange={onWebsiteChange}
        onAccountChange={onAccountChange}
        allowAll
      />,
    );

    expect(screen.getAllByText(/website/i).length).toBeGreaterThan(0);
    
    // Wait for effects to fire (they run after render)
    await waitFor(() => {
      expect(onWebsiteChange).toHaveBeenCalled();
    }, { timeout: 1000 });
    
    await waitFor(() => {
      expect(onAccountChange).toHaveBeenCalled();
    }, { timeout: 1000 });
  });
});



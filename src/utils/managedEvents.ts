import { invoke } from "@tauri-apps/api/core";

export type ManagedEventType = "otb_tournament";

export type ManagedEvent = {
  id: number;
  name?: string | null;
  event_type?: string | null;
  location?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

export async function listManagedEvents(file: string): Promise<ManagedEvent[]> {
  return (await invoke<ManagedEvent[]>("list_managed_events", { file })) ?? [];
}

export async function upsertManagedEvent(
  file: string,
  payload: {
    name: string;
    eventType: ManagedEventType;
    location?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  },
): Promise<ManagedEvent> {
  return await invoke<ManagedEvent>("upsert_managed_event", {
    file,
    payload: {
      name: payload.name,
      eventType: payload.eventType,
      location: payload.location ?? null,
      startDate: payload.startDate ?? null,
      endDate: payload.endDate ?? null,
    },
  });
}

export async function deleteManagedEvent(file: string, eventId: number): Promise<boolean> {
  return await invoke<boolean>("delete_managed_event", { file, eventId });
}

export async function addEventGamesFromPgn(file: string, eventId: number, pgn: string): Promise<number> {
  return await invoke<number>("add_event_games_from_pgn", { file, eventId, pgn });
}

export async function createEventGame(
  file: string,
  eventId: number,
  payload: {
    white: string;
    black: string;
    date?: string | null;
    round?: string | null;
    result: "1-0" | "0-1" | "1/2-1/2" | "*";
  },
): Promise<number> {
  return await invoke<number>("create_event_game", {
    file,
    eventId,
    payload: {
      white: payload.white,
      black: payload.black,
      date: payload.date ?? null,
      round: payload.round ?? null,
      result: payload.result,
    },
  });
}

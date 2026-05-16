import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { error } from "@tauri-apps/plugin-log";

export interface TournamentTemplate {
  id: string;
  accountName: string; // Associated with main account
  name: string;
  description: string;
  clockTime: number;
  clockIncrement: number;
  minutes: number;
  variant: string;
  rated: boolean;
  position: string;
  berserkable: boolean;
  streakable: boolean;
  hasChat: boolean;
  password: string;
  teamBattleByTeam: string;
  teamRestriction: string;
  conditions: {
    minRating: {
      enabled: boolean;
      rating: number;
    };
    maxRating: {
      enabled: boolean;
      rating: number;
    };
    nbRatedGame: {
      enabled: boolean;
      nb: number;
    };
  };
  createdAt: number;
}

const FILENAME = "tournament_templates.json";

export async function saveTournamentTemplate(
  template: Omit<TournamentTemplate, "id" | "createdAt" | "accountName">,
  accountName: string,
): Promise<TournamentTemplate> {
  try {
    const dir = await appDataDir();

    // Ensure directory exists
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }

    const file = await resolve(dir, FILENAME);

    let templates: TournamentTemplate[] = [];
    try {
      if (await exists(file)) {
        const text = await readTextFile(file);
        templates = JSON.parse(text);
      }
    } catch (err) {
      error(`[tournamentTemplates] Failed to read existing tournament templates: ${err}`);
      // Continue with empty array
    }

    const newTemplate: TournamentTemplate = {
      ...template,
      accountName,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };

    templates.unshift(newTemplate);

    await writeTextFile(file, JSON.stringify(templates, null, 2));

    return newTemplate;
  } catch (err) {
    error(`[tournamentTemplates] Failed to save tournament template: ${err}`);
    throw err;
  }
}

export async function getTournamentTemplates(accountName: string): Promise<TournamentTemplate[]> {
  try {
    const dir = await appDataDir();

    const file = await resolve(dir, FILENAME);

    // Check if file exists
    if (!(await exists(file))) {
      return [];
    }

    try {
      const text = await readTextFile(file);

      const allTemplates: TournamentTemplate[] = JSON.parse(text);
      // Filter templates by account name (templates without accountName are ignored)
      const templates = allTemplates.filter((t) => t.accountName === accountName);

      return templates;
    } catch (err) {
      error(`[tournamentTemplates] Failed to read or parse tournament templates from ${file}: ${err}`);
      return [];
    }
  } catch (err) {
    error(`[tournamentTemplates] Failed to get tournament templates: ${err}`);
    return [];
  }
}

export async function deleteTournamentTemplate(id: string, accountName: string): Promise<void> {
  try {
    const dir = await appDataDir();
    const file = await resolve(dir, FILENAME);

    let templates: TournamentTemplate[] = [];
    try {
      if (await exists(file)) {
        const text = await readTextFile(file);
        templates = JSON.parse(text);
      }
    } catch (err) {
      error(`[tournamentTemplates] Failed to read tournament templates: ${err}`);
      return;
    }

    // Only delete if it belongs to the current account
    const filteredTemplates = templates.filter((t) => !(t.id === id && t.accountName === accountName));
    await writeTextFile(file, JSON.stringify(filteredTemplates, null, 2));
  } catch (err) {
    error(`[tournamentTemplates] Failed to delete tournament template: ${err}`);
    throw err;
  }
}

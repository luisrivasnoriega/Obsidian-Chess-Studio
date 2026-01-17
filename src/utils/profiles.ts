import type { Profile } from "@/state/atoms";
import type { Session } from "@/utils/session";
import { genID } from "@/utils/tabs";

function sessionUsername(session: Session): string | null {
  return session.lichess?.username ?? session.chessCom?.username ?? null;
}

export function normalizeProfileName(name: string) {
  return name.trim();
}

export function ensureProfilesInitialized(input: {
  sessions: Session[];
  profiles: Profile[];
  activeProfileId: string | null;
}) {
  const now = Date.now();
  const profilesById = new Map(input.profiles.map((p) => [p.id, p] as const));
  const profilesByNameLower = new Map(input.profiles.map((p) => [p.name.toLowerCase(), p] as const));

  const profiles: Profile[] = [...input.profiles];

  const ensureProfile = (name: string): Profile => {
    const normalized = normalizeProfileName(name);
    const existing = profilesByNameLower.get(normalized.toLowerCase());
    if (existing) return existing;
    const created: Profile = { id: genID(), name: normalized, createdAt: now, updatedAt: now };
    profiles.push(created);
    profilesById.set(created.id, created);
    profilesByNameLower.set(created.name.toLowerCase(), created);
    return created;
  };

  // Only process sessions that already exist in the input - don't add new ones
  // This prevents restoring deleted sessions from localStorage
  const sessions: Session[] = input.sessions.map((s) => {
    const username = sessionUsername(s);
    const desiredName = normalizeProfileName(s.player ?? username ?? "Profile");

    if (s.profileId && profilesById.has(s.profileId)) {
      const current = profilesById.get(s.profileId)!;
      if (current.name.toLowerCase() === desiredName.toLowerCase()) {
        if (s.player !== current.name) return { ...s, player: current.name };
        return s;
      }
      const next = ensureProfile(desiredName);
      return { ...s, profileId: next.id, player: next.name };
    }

    const profile = ensureProfile(desiredName);
    return { ...s, profileId: profile.id, player: profile.name };
  });

  let activeProfileId = input.activeProfileId;
  if (activeProfileId && !profilesById.has(activeProfileId)) activeProfileId = null;
  if (!activeProfileId) {
    activeProfileId = sessions.find((s) => s.profileId)?.profileId ?? profiles[0]?.id ?? null;
  }

  return { sessions, profiles, activeProfileId };
}

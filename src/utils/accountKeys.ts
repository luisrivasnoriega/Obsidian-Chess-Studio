export type AccountPlatform = "lichess" | "chesscom";

export function getAccountKey(platform: AccountPlatform, username: string): string {
  return `${platform}:${username}`;
}

export function stripAccountKey(value: string): string {
  const match = value.match(/^(lichess|chesscom):(.*)$/i);
  if (!match) return value;
  return match[2] ?? value;
}

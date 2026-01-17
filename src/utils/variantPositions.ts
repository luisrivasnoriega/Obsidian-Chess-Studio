import { invoke } from "@tauri-apps/api/core";

export type VariantPosition = {
  fen: string;
  engine: string;
  recommended_move: string;
  ms: number;
};

export async function getVariantPosition(fen: string, engine: string): Promise<VariantPosition | null> {
  // biome-ignore lint/suspicious/noExplicitAny: Tauri invoke returns unknown, we validate the structure
  const result = (await invoke<unknown>("get_variant_position", { fen, engine })) as VariantPosition | null;
  if (!result) return null;

  // Handle BigInt conversion - Tauri may return it as bigint, string, or object
  let ms: number;
  if (typeof result.ms === "bigint") {
    ms = Number(result.ms);
  } else if (typeof result.ms === "string") {
    ms = Number.parseInt(result.ms, 10);
  } else if (typeof result.ms === "number") {
    ms = result.ms;
  } else if (result.ms && typeof result.ms === "object" && "value" in result.ms) {
    // Handle object format like {type: "bigint", value: "123"}
    const value = (result.ms as { value: string | number }).value;
    ms = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  } else {
    ms = 0;
  }

  return {
    fen: result.fen,
    engine: result.engine,
    recommended_move: result.recommended_move || (result as { recommendedMove?: string }).recommendedMove || "",
    ms,
  };
}

export async function upsertVariantPosition(
  fen: string,
  engine: string,
  recommended_move: string,
  ms: number,
): Promise<void> {
  // Tauri can automatically convert JavaScript numbers to i64 in Rust
  // We pass the number directly instead of BigInt to avoid JSON serialization issues
  // The Rust side expects i64, and Tauri will handle the conversion
  await invoke("upsert_variant_position", {
    fen,
    engine,
    recommendedMove: recommended_move,
    ms: ms, // Pass as number, Tauri will convert to i64
  });
}

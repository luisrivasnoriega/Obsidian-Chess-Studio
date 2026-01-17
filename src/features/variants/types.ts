export type VariantInfo = {
  name: string;
  path: string;
  opening: string | null;
  fen: string | null;
  depth: number | null;
  database: string | null;
  engine: string | null;
  engineMs: number | null;
  variantsCount: number | null;
  comments: string | null;
};

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
  parentLink?: VariantLinkRef | null;
  childLinks?: VariantLinkRef[];
};

export type VariantLinkRef = {
  path: string;
  name: string;
  anchorFen: string;
  anchorPath: number[];
  anchorPly: number;
  label?: string;
};

export type VariantLinks = {
  parent?: VariantLinkRef;
  children?: VariantLinkRef[];
};

export type VariantSplitMetadata = {
  mode: "manual" | "auto";
  splitAtPly?: number;
  createdAt: string;
};

export type VariantInfoSchemaV2 = {
  type: "variants";
  tags: string[];
  schemaVersion?: 2;
  links?: VariantLinks;
  split?: VariantSplitMetadata;
};

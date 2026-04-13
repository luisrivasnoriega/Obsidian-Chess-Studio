import { invoke } from "@tauri-apps/api/core";

export const ORION_PLAN_PROVIDER_SIGNATURE = "luis-4944-resource:luis-4944:gpt-5.3-chat";

export type OrionPlanRequest = {
  apiKey: string;
  orientation: "white" | "black";
  contextJson: string;
  model?: string;
  uiLanguage?: string;
};

export type OrionPlanAnalysisRequest = {
  apiKey: string;
  orientation: "white" | "black";
  model?: string;
  uiLanguage?: string;
  premiumUser?: string;
  rootFen: string;
  finalFen: string;
  fenTrail: string[];
  gameMovesUci: string[];
  engineName: string;
  engineGoJson: string;
  engineSettingsJson: string;
  engineLinesJson: string;
  dbType: "local" | "lch_all" | "lch_master";
  lichessOptionsJson?: string;
  masterOptionsJson?: string;
  lichessToken?: string;
};

export type OrionPlanResponse = {
  plan: string;
  raw: string;
  systemPrompt: string;
  userPrompt: string;
  payloadJson: string;
};

export async function consultOrionPlan(request: OrionPlanRequest): Promise<OrionPlanResponse> {
  return await invoke<OrionPlanResponse>("consult_orion_plan", { request });
}

export async function consultOrionPlanFromAnalysis(request: OrionPlanAnalysisRequest): Promise<OrionPlanResponse> {
  return await invoke<OrionPlanResponse>("consult_orion_plan_from_analysis", { request });
}

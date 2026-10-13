import type { BaseCv } from "./cv.ts";

export type Gate = "PASS" | "FLAG" | "FAIL";

/** What the model submits for one job. The match percentage is computed here, not by the model. */
export interface ScoreInput {
  requirements: Array<{
    text: string;
    importance: "must" | "nice";
    status: "met" | "partial" | "gap";
    /** CV references: bullet ids ("e2.b3"), "summary", "skill:<name>", "cert:<name>", "lang:<language>", "edu". */
    evidence: string[];
  }>;
  contractGate: Gate;
  contractNote: string;
  locationGate: Gate;
  locationNote: string;
  languageGate: Gate;
  languageNote: string;
  dayRate: string | null;
  summary: string;
  redFlags: string[];
}

export interface ScoreRecord extends ScoreInput {
  matchPercent: number;
  verdict: "shortlist" | "near-miss" | "below" | "gated";
  scoredAt: string;
  model: string;
}

const WEIGHT = { must: 2, nice: 1 } as const;
const CREDIT = { met: 1, partial: 0.5, gap: 0 } as const;

export function matchPercent(requirements: ScoreInput["requirements"]): number {
  const total = requirements.reduce((sum, r) => sum + WEIGHT[r.importance], 0);
  if (!total) return 0;
  const earned = requirements.reduce((sum, r) => sum + WEIGHT[r.importance] * CREDIT[r.status], 0);
  return Math.round((earned / total) * 1000) / 10;
}

function hasEvidence(ref: string, cv: BaseCv): boolean {
  const lower = (s: string) => s.trim().toLowerCase();
  if (ref === "summary" || ref === "edu") return true;
  const [kind, ...rest] = ref.split(":");
  const name = lower(rest.join(":"));
  if (kind === "skill") return cv.skills.some((s) => lower(s) === name);
  if (kind === "cert") return cv.certifications.some((c) => lower(c).includes(name));
  if (kind === "lang") return cv.languages.some((l) => lower(l.language) === name);
  return cv.experience.some((role) => role.bullets.some((b) => b.id === ref));
}

/** Returns a list of problems; empty means the submission is acceptable. */
export function validateScore(input: ScoreInput, cv: BaseCv): string[] {
  const problems: string[] = [];
  const reqs = input.requirements ?? [];
  if (reqs.length < 4) problems.push("list at least 4 requirements from the posting (all real must-haves plus nice-to-haves)");
  if (reqs.length > 30) problems.push("list at most 30 requirements; merge near-duplicates");
  if (!reqs.some((r) => r.importance === "must")) problems.push("at least one requirement must have importance \"must\"");
  reqs.forEach((r, i) => {
    if (r.status !== "gap" && !r.evidence?.length) problems.push(`requirement ${i + 1} ("${r.text}") is ${r.status} but cites no CV evidence`);
    for (const ref of r.evidence ?? []) {
      if (!hasEvidence(ref, cv)) problems.push(`requirement ${i + 1} cites "${ref}", which does not exist in the CV`);
    }
  });
  if (!input.summary?.trim()) problems.push("summary is empty");
  return problems;
}

export function finalizeScore(input: ScoreInput, threshold: number, nearMiss: number, model: string): ScoreRecord {
  const percent = matchPercent(input.requirements);
  const gated = [input.contractGate, input.locationGate, input.languageGate].includes("FAIL");
  const verdict = gated ? "gated" : percent >= threshold ? "shortlist" : percent >= nearMiss ? "near-miss" : "below";
  return { ...input, matchPercent: percent, verdict, scoredAt: new Date().toISOString(), model };
}

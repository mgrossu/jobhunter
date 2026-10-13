import { readFileSync } from "node:fs";
import { PATHS } from "./config.ts";

/**
 * The approved, structured version of the user's CV. Every tailored CV is assembled
 * from these entries, so nothing in it can be invented by the model.
 */
export interface BaseCv {
  name: string;
  headline: string;
  contact: { email?: string; phone?: string; location?: string; linkedin?: string; website?: string };
  summary: string;
  skills: string[];
  experience: Array<{
    id: string; // "e1", "e2", ... newest first
    company: string;
    role: string;
    start: string;
    end: string;
    location?: string;
    engagement?: string; // e.g. "B2B contract", "Employee"
    bullets: Array<{ id: string; text: string }>; // "e1.b1", ...
  }>;
  education: Array<{ institution: string; degree: string; year?: string }>;
  certifications: string[];
  languages: Array<{ language: string; level: string }>;
}

export interface Preferences {
  targetRoles: string[];
  /** Engagement types the user accepts, e.g. ["B2B", "IČO / živnostenský list", "freelance", "contract"]. */
  contractTypes: string[];
  /** Whether a permanent employment contract is acceptable at all. */
  acceptEmployment: boolean;
  homeBase: string; // "Prague, CZ"
  remoteRegions: string[]; // ["EU", "EEA", "CET ±2h"]
  onsiteCities: string[]; // cities where hybrid/onsite is fine
  minDayRateEur?: number;
  dealbreakers: string[];
  notes?: string;
}

export function validateBaseCv(cv: BaseCv): string[] {
  const problems: string[] = [];
  if (!cv.name?.trim()) problems.push("name is empty");
  if (!cv.experience?.length) problems.push("experience is empty");
  const ids = new Set<string>();
  for (const role of cv.experience ?? []) {
    if (!/^e\d+$/.test(role.id)) problems.push(`experience id "${role.id}" must look like e1, e2, ...`);
    if (ids.has(role.id)) problems.push(`duplicate id ${role.id}`);
    ids.add(role.id);
    if (!role.bullets?.length) problems.push(`${role.id} has no bullets`);
    for (const bullet of role.bullets ?? []) {
      if (!bullet.id.startsWith(`${role.id}.b`)) problems.push(`bullet id "${bullet.id}" must start with "${role.id}.b"`);
      if (ids.has(bullet.id)) problems.push(`duplicate id ${bullet.id}`);
      ids.add(bullet.id);
      if (!bullet.text?.trim()) problems.push(`${bullet.id} is empty`);
    }
  }
  return problems;
}

export function loadBaseCv(): BaseCv {
  let cv: BaseCv;
  try {
    cv = JSON.parse(readFileSync(PATHS.baseCv, "utf8")) as BaseCv;
  } catch {
    throw new Error(`No approved CV at ${PATHS.baseCv}. Put your CV in data/ and run /jh-setup in pi.`);
  }
  const problems = validateBaseCv(cv);
  if (problems.length) throw new Error(`data/cv.base.json is invalid: ${problems.join("; ")}`);
  return cv;
}

export function loadPreferences(): Preferences {
  try {
    return JSON.parse(readFileSync(PATHS.preferences, "utf8")) as Preferences;
  } catch {
    throw new Error(`No preferences at ${PATHS.preferences}. Run /jh-setup in pi.`);
  }
}

/** Plain-text CV with ids, as the model sees it when scoring and tailoring. */
export function cvAsText(cv: BaseCv): string {
  const lines = [
    `# ${cv.name} — ${cv.headline}`,
    `Location: ${cv.contact.location ?? "n/a"}`,
    "",
    "## Summary [id: summary]",
    cv.summary,
    "",
    "## Skills [cite as skill:<name>]",
    cv.skills.join(", "),
    "",
    "## Experience",
  ];
  for (const role of cv.experience) {
    lines.push(`### [${role.id}] ${role.role} — ${role.company} (${role.start} – ${role.end})${role.engagement ? ` · ${role.engagement}` : ""}${role.location ? ` · ${role.location}` : ""}`);
    for (const bullet of role.bullets) lines.push(`- [${bullet.id}] ${bullet.text}`);
  }
  lines.push("", "## Certifications [cite as cert:<name>]", ...cv.certifications.map((c) => `- ${c}`));
  lines.push("", "## Languages [cite as lang:<language>]", ...cv.languages.map((l) => `- ${l.language}: ${l.level}`));
  lines.push("", "## Education [cite as edu]", ...cv.education.map((e) => `- ${e.degree}, ${e.institution}${e.year ? ` (${e.year})` : ""}`));
  return lines.join("\n");
}

export function cvCorpus(cv: BaseCv): string {
  return cvAsText(cv).toLowerCase();
}

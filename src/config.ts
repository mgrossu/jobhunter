import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  config: join(ROOT, "config", "jobhunter.json"),
  data: join(ROOT, "data"),
  baseCv: join(ROOT, "data", "cv.base.json"),
  preferences: join(ROOT, "data", "preferences.json"),
  state: join(ROOT, ".jobhunter"),
  jobs: join(ROOT, ".jobhunter", "jobs"),
  out: join(ROOT, "out"),
  reports: join(ROOT, "reports"),
  logs: join(ROOT, "logs"),
  nightlyPrompts: join(ROOT, "nightly-prompts"),
  extension: join(ROOT, "extensions", "index.ts"),
  piAgentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
};

export type SourceName = "linkedin" | "himalayas" | "jobicy" | "jobscz" | "freelancermap";

export interface SearchSpec {
  source: SourceName;
  keywords: string;
  /** Free-text location understood by the source (e.g. "Prague", "European Union"). */
  location?: string;
  /** Source-side contract/freelance filter where the source supports one. */
  contract?: boolean;
  remote?: boolean;
  /** Only postings from the last N days where the source supports it. */
  maxAgeDays?: number;
}

export interface Limits {
  maxNewJobsPerRun: number;
  maxRuntimeMinutes: number;
  detailDelayMs: number;
  maxDescriptionChars: number;
  maxTailoredPerRun: number;
}

/** One machine/model combination. The provider and model must exist in that machine's pi models.json. */
export interface Profile {
  provider: string;
  model: string;
  thinkingScore: string;
  thinkingTailor: string;
  /** Per-job hard timeout for one pi invocation. */
  timeoutMinutes: number;
  /** Context window the server is configured for; prompts that would not fit are skipped, not silently truncated. */
  contextTokens: number;
  /** Per-profile overrides, e.g. a fast Mac can take more jobs per night than a CPU-only NUC. */
  limits?: Partial<Limits>;
}

export interface Config {
  threshold: number;
  nearMiss: number;
  defaultProfile: string;
  profiles: Record<string, Profile>;
  limits: Limits;
  searches: SearchSpec[];
  titleInclude: string[];
  titleExclude: string[];
  notify: { ntfyUrl: string | null };
}

export interface ResolvedConfig extends Config {
  profileName: string;
  profile: Profile;
}

/** Profile comes from --profile=<name>, then JH_PROFILE, then config.defaultProfile. */
export function loadConfig(path = PATHS.config, argv = process.argv, env = process.env): ResolvedConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (!(config.threshold > 0 && config.threshold <= 100)) throw new Error("config.threshold must be in (0, 100]");
  if (!(config.nearMiss > 0 && config.nearMiss <= config.threshold)) throw new Error("config.nearMiss must be in (0, threshold]");
  if (!config.searches?.length) throw new Error("config.searches is empty");
  const profileName = argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length) ?? env.JH_PROFILE ?? config.defaultProfile;
  const profile = config.profiles?.[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}"; config.profiles has: ${Object.keys(config.profiles ?? {}).join(", ")}`);
  return { ...config, limits: { ...config.limits, ...profile.limits }, profileName, profile };
}

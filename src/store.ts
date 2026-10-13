import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "./config.ts";
import type { ScoreRecord } from "./score.ts";
import type { TailoredCv } from "./tailor.ts";

export type JobStatus =
  | "fetched"       // listing + description stored, waiting for scoring
  | "scored"        // scored, below threshold or gated out
  | "score-failed"  // model never produced a valid score
  | "shortlisted"   // >= threshold and no failing gate
  | "tailored"      // tailored CV ready for review
  | "applying"      // user confirmed; apply page opened
  | "applied"
  | "skipped";

export interface Job {
  id: string;
  source: string;
  sourceId: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  applyUrl: string | null;
  datePosted: string | null;
  employmentType: string | null;
  remote: string | null;
  description: string | null;
  attribution: string;
  firstSeen: string;
  status: JobStatus;
  scoreAttempts?: number;
  score?: ScoreRecord;
  tailored?: TailoredCv & { dir: string; files: string[] };
  history: Array<{ at: string; status: JobStatus; note?: string }>;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Same title at the same company is one job, whichever board it came from. */
export function jobId(title: string, company: string | null, url: string): string {
  const key = norm(title) && norm(company) ? `${norm(title)}|${norm(company)}` : norm(url);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function jobPath(id: string): string {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error(`invalid job id: ${id}`);
  return join(PATHS.jobs, `${id}.json`);
}

export function hasJob(id: string): boolean {
  return existsSync(jobPath(id));
}

export function readJob(id: string): Job {
  try {
    return JSON.parse(readFileSync(jobPath(id), "utf8")) as Job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown job id: ${id}`);
    throw error;
  }
}

export function saveJob(job: Job): void {
  writeJsonAtomic(jobPath(job.id), job);
}

export function setStatus(job: Job, status: JobStatus, note?: string): Job {
  job.status = status;
  job.history.push({ at: new Date().toISOString(), status, ...(note ? { note } : {}) });
  saveJob(job);
  return job;
}

export function listJobs(filter?: (job: Job) => boolean): Job[] {
  if (!existsSync(PATHS.jobs)) return [];
  return readdirSync(PATHS.jobs)
    .filter((name) => /^[a-f0-9]{16}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(PATHS.jobs, name), "utf8")) as Job)
    .filter((job) => (filter ? filter(job) : true));
}

export function readJsonIfExists<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, PATHS, ROOT, type ResolvedConfig } from "./config.ts";
import { cvAsText, loadBaseCv, loadPreferences, type BaseCv, type Preferences } from "./cv.ts";
import { fetchJobs } from "./fetch.ts";
import { estimateTokens, readEndpoint, resolvePi, waitForServer, type PiCommand } from "./llm.ts";
import { writeReport, type RunStats } from "./report.ts";
import { listJobs, readJob, saveJob, setStatus, type Job } from "./store.ts";

const MAX_ATTEMPTS = 2;
/** Room for pi's tool schema, the system prompt and the model's answer. */
const RESERVED_TOKENS = 4_500;

mkdirSync(PATHS.logs, { recursive: true });
const logFile = join(PATHS.logs, `nightly-${new Date().toISOString().slice(0, 10)}.log`);
function log(line: string): void {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(stamped);
  appendFileSync(logFile, `${stamped}\n`);
}

/** A lock older than the run budget is stale (a crash, or a container restart that reused the pid). */
function acquireLock(maxAgeMinutes: number): boolean {
  const lock = join(PATHS.state, "nightly.lock");
  mkdirSync(PATHS.state, { recursive: true });
  try {
    const fresh = Date.now() - statSync(lock).mtimeMs < (maxAgeMinutes + 60) * 60_000;
    process.kill(Number(readFileSync(lock, "utf8")), 0); // throws if that process is gone
    if (fresh) return false;
  } catch { /* no lock, or a stale one */ }
  writeFileSync(lock, String(process.pid));
  process.on("exit", () => rmSync(lock, { force: true }));
  return true;
}

function jobBlock(job: Job): string {
  return [
    `<job_posting id="${job.id}" trust="untrusted">`,
    `Title: ${job.title}`,
    `Company: ${job.company ?? "unknown"}`,
    `Location: ${job.location ?? "unknown"}${job.remote ? ` (${job.remote})` : ""}`,
    `Employment type: ${job.employmentType ?? "not stated"}`,
    `Source: ${job.attribution}`,
    "",
    job.description ?? "",
    "</job_posting>",
  ].join("\n");
}

/** Candidate context first so the server can reuse the cached prefix across jobs. */
function candidateBlock(cv: BaseCv, prefs: Preferences): string {
  return `<candidate_cv>\n${cvAsText(cv)}\n</candidate_cv>\n\n<candidate_preferences>\n${JSON.stringify(prefs, null, 2)}\n</candidate_preferences>`;
}

/**
 * One bounded pi run. The large context goes through stdin (pi prepends it to the prompt) and the
 * system prompt is passed as a file path, so the command line stays short on every OS.
 */
function runPi(pi: PiCommand, config: ResolvedConfig, opts: { tool: string; thinking: string; systemPromptFile: string; context: string; instruction: string; jobId: string }): Promise<{ code: number | null; output: string }> {
  const { provider, model, timeoutMinutes } = config.profile;
  const args = [
    ...pi.args,
    "-p", "--no-session",
    "-ne", "-e", PATHS.extension,
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp", "--offline",
    "--tools", opts.tool,
    "--provider", provider, "--model", model,
    "--thinking", opts.thinking,
    "--system-prompt", opts.systemPromptFile,
    "--", opts.instruction,
  ];
  return new Promise((resolve) => {
    const child = spawn(pi.command, args, {
      cwd: ROOT,
      env: { ...process.env, JH_EXPECTED_JOB: opts.jobId, JH_MODEL_LABEL: `${provider}/${model}` },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.stdin.on("error", () => { /* pi exited before reading stdin; reported via exit code */ });
    child.stdin.end(opts.context);
    const timer = setTimeout(() => { output += "\n[timeout]"; child.kill(); }, timeoutMinutes * 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.trim().slice(-2000) }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: String(error) }); });
  });
}

async function notify(config: ResolvedConfig, title: string, body: string): Promise<void> {
  if (!config.notify.ntfyUrl) return;
  try {
    await fetch(config.notify.ntfyUrl, { method: "POST", headers: { Title: title, Tags: "briefcase" }, body, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    log(`notify failed: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!acquireLock(config.limits.maxRuntimeMinutes)) { log("another nightly run is active; exiting"); return; }
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + config.limits.maxRuntimeMinutes * 60_000;
  const stats: RunStats = { startedAt, finishedAt: startedAt, fetch: null, scored: 0, scoreFailed: 0, tailored: 0, leftForNextRun: 0, notes: [] };
  const skipFetch = process.argv.includes("--no-fetch");

  const cv = loadBaseCv();
  const prefs = loadPreferences();
  const candidate = candidateBlock(cv, prefs);
  const scorePromptFile = join(PATHS.nightlyPrompts, "score.md");
  const tailorPromptFile = join(PATHS.nightlyPrompts, "tailor.md");
  const promptOverhead = estimateTokens(readFileSync(scorePromptFile, "utf8")) + RESERVED_TOKENS;
  const fits = (context: string) => estimateTokens(context) + promptOverhead <= config.profile.contextTokens;

  const pi = resolvePi();
  const endpoint = readEndpoint(config.profile);
  log(`nightly start; profile ${config.profileName} (${config.profile.provider}/${config.profile.model} at ${endpoint.baseUrl}); threshold ${config.threshold}%; pi: ${pi.description}`);

  if (!skipFetch) {
    log("fetch: searching sources");
    stats.fetch = await fetchJobs(config, log);
    log(`fetch: stored ${stats.fetch.stored} new jobs (${stats.fetch.deferred} deferred to a later run)`);
  }

  const serverProblem = await waitForServer(endpoint);
  if (serverProblem) {
    stats.notes.push(`Scoring skipped: ${serverProblem}`);
    log(serverProblem);
  } else {
    // Score: oldest first, so leftovers from previous nights go before new ones.
    const pending = listJobs((j) => j.status === "fetched").sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    log(`score: ${pending.length} jobs waiting`);
    for (const [index, pendingJob] of pending.entries()) {
      if (Date.now() > deadline) { stats.leftForNextRun = pending.length - index; stats.notes.push("Time budget reached during scoring."); break; }
      const job = readJob(pendingJob.id);
      const context = `${candidate}\n\n${jobBlock(job)}`;
      if (!fits(context)) {
        setStatus(job, "score-failed", `prompt ~${estimateTokens(context) + promptOverhead} tokens exceeds profile contextTokens ${config.profile.contextTokens}`);
        stats.scoreFailed += 1;
        log(`score: skipped ${job.id}, prompt too large for the ${config.profile.contextTokens}-token context`);
        continue;
      }
      const started = Date.now();
      const result = await runPi(pi, config, {
        tool: "jh_record_score", thinking: config.profile.thinkingScore, systemPromptFile: scorePromptFile, jobId: job.id, context,
        instruction: `Assess the job posting above for the candidate and call jh_record_score with jobId "${job.id}".`,
      });
      const after = readJob(job.id);
      const minutes = ((Date.now() - started) / 60_000).toFixed(1);
      if (after.score && after.status !== "fetched") {
        stats.scored += 1;
        log(`score: ${after.score.matchPercent}% ${after.score.verdict} — ${job.title} @ ${job.company} (${minutes} min)`);
      } else {
        after.scoreAttempts = (after.scoreAttempts ?? 0) + 1;
        saveJob(after);
        log(`score: no valid score for ${job.id} (attempt ${after.scoreAttempts}, exit ${result.code}, ${minutes} min): ${result.output.split("\n").slice(-3).join(" | ")}`);
        if (after.scoreAttempts >= MAX_ATTEMPTS) { setStatus(after, "score-failed", result.output.slice(-300)); stats.scoreFailed += 1; }
      }
    }

    // Tailor: best matches first.
    const toTailor = listJobs((j) => j.status === "shortlisted").sort((a, b) => b.score!.matchPercent - a.score!.matchPercent).slice(0, config.limits.maxTailoredPerRun);
    for (const job of toTailor) {
      if (Date.now() > deadline) { stats.notes.push("Time budget reached during tailoring; remaining CVs will be tailored next run."); break; }
      const gaps = job.score!.requirements.filter((r) => r.status !== "met").map((r) => `- ${r.text} (${r.importance}, ${r.status})`).join("\n");
      const result = await runPi(pi, config, {
        tool: "jh_save_tailored_cv", thinking: config.profile.thinkingTailor, systemPromptFile: tailorPromptFile, jobId: job.id,
        context: `${candidate}\n\n${jobBlock(job)}\n\nKnown gaps (do not claim these):\n${gaps || "- none"}`,
        instruction: `Tailor the CV for the job posting above and call jh_save_tailored_cv with jobId "${job.id}".`,
      });
      const after = readJob(job.id);
      if (after.status === "tailored") { stats.tailored += 1; log(`tailor: ${after.tailored!.dir}`); }
      else log(`tailor: failed for ${job.id} (exit ${result.code}): ${result.output.split("\n").slice(-3).join(" | ")}`);
    }
  }

  stats.finishedAt = new Date().toISOString();
  const report = writeReport(config, stats);
  log(`report: ${report.htmlPath} — ${report.headline}`);
  await notify(config, "Job hunt report", `${report.headline}\n${report.htmlPath}`);
}

main().catch((error) => {
  log(`FATAL ${(error as Error).stack ?? error}`);
  process.exitCode = 1;
});

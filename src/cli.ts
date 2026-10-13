import { loadConfig } from "./config.ts";
import { fetchJobs } from "./fetch.ts";
import { writeReport } from "./report.ts";
import { listJobs } from "./store.ts";

const [command] = process.argv.slice(2);
const config = loadConfig();

switch (command) {
  case "fetch": {
    // Dry run of the sources: stores new jobs as "fetched"; the nightly run scores them.
    const summary = await fetchJobs(config, console.log);
    console.log(JSON.stringify(summary, null, 2));
    break;
  }
  case "report": {
    const now = new Date().toISOString();
    const { htmlPath, headline } = writeReport(config, { startedAt: now, finishedAt: now, fetch: null, scored: 0, scoreFailed: 0, tailored: 0, leftForNextRun: 0, notes: ["Report regenerated manually."] });
    console.log(`${headline}\n${htmlPath}`);
    break;
  }
  case "status": {
    const counts: Record<string, number> = {};
    for (const job of listJobs()) counts[job.status] = (counts[job.status] ?? 0) + 1;
    console.log(counts);
    for (const job of listJobs((j) => ["shortlisted", "tailored", "applying"].includes(j.status)).sort((a, b) => b.score!.matchPercent - a.score!.matchPercent)) {
      console.log(`${job.score!.matchPercent.toString().padStart(5)}%  ${job.status.padEnd(11)} ${job.id}  ${job.title} — ${job.company ?? "?"}`);
    }
    break;
  }
  default:
    console.log("usage: node src/cli.ts <fetch|report|status>");
    process.exitCode = 1;
}

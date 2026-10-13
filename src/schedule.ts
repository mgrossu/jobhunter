import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./config.ts";

// Minimal daily scheduler for containers and other places without cron or Task Scheduler.
// JH_RUN_AT=HH:MM in the container's local time (set TZ). Extra arguments go to nightly.ts.
// Pass --now to also run once immediately.

const runAt = process.env.JH_RUN_AT ?? "00:30";
const match = runAt.match(/^(\d{1,2}):(\d{2})$/);
if (!match) throw new Error(`JH_RUN_AT must be HH:MM, got "${runAt}"`);
const [hour, minute] = [Number(match[1]), Number(match[2])];
const passThrough = process.argv.slice(2).filter((a) => a !== "--now");

function nextRun(from = new Date()): Date {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

function runNightly(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "src", "nightly.ts"), ...passThrough], { cwd: ROOT, stdio: "inherit" });
    child.on("close", (code) => { console.log(`[schedule] nightly exited with ${code}`); resolve(); });
    child.on("error", (error) => { console.log(`[schedule] could not start nightly: ${error}`); resolve(); });
  });
}

if (process.argv.includes("--now")) await runNightly();
for (;;) {
  const next = nextRun();
  console.log(`[schedule] next run ${next.toString()}`);
  // Sleep in chunks so clock changes (DST, host sleep) are picked up.
  while (Date.now() < next.getTime()) await new Promise((r) => setTimeout(r, Math.min(next.getTime() - Date.now(), 5 * 60_000)));
  await runNightly();
}

import type { Config } from "./config.ts";
import { sleep } from "./http.ts";
import { SOURCES, type Listing } from "./sources.ts";
import { hasJob, jobId, saveJob, type Job } from "./store.ts";

export interface FetchSummary {
  listed: number;
  titleFiltered: number;
  alreadySeen: number;
  stored: number;
  deferred: number;
  failures: Array<{ where: string; error: string }>;
}

export function titleFilter(config: Pick<Config, "titleInclude" | "titleExclude">) {
  const include = config.titleInclude.map((p) => new RegExp(p, "i"));
  const exclude = config.titleExclude.map((p) => new RegExp(p, "i"));
  return (title: string) => include.some((r) => r.test(title)) && !exclude.some((r) => r.test(title));
}

/**
 * Lists every configured search, keeps unseen postings whose title looks like a PM/delivery role,
 * fetches their descriptions politely, and stores them as "fetched" jobs for scoring.
 */
export async function fetchJobs(config: Config, log: (line: string) => void): Promise<FetchSummary> {
  const summary: FetchSummary = { listed: 0, titleFiltered: 0, alreadySeen: 0, stored: 0, deferred: 0, failures: [] };
  const wanted = titleFilter(config);
  const candidates = new Map<string, Listing>();

  for (const spec of config.searches) {
    const label = `${spec.source}:"${spec.keywords}"${spec.location ? ` @ ${spec.location}` : ""}`;
    try {
      const listings = await SOURCES[spec.source].search(spec);
      summary.listed += listings.length;
      let kept = 0;
      for (const listing of listings) {
        if (!wanted(listing.title)) { summary.titleFiltered += 1; continue; }
        const id = jobId(listing.title, listing.company, listing.url);
        if (hasJob(id) || candidates.has(id)) { summary.alreadySeen += 1; continue; }
        candidates.set(id, listing);
        kept += 1;
      }
      log(`  ${label}: ${listings.length} listed, ${kept} new`);
    } catch (error) {
      summary.failures.push({ where: label, error: (error as Error).message });
      log(`  ${label}: FAILED ${(error as Error).message}`);
    }
    await sleep(config.limits.detailDelayMs);
  }

  const queue = [...candidates.entries()];
  summary.deferred = Math.max(0, queue.length - config.limits.maxNewJobsPerRun);
  // Deferred jobs are not stored, so they are discovered again next run if still listed.
  for (const [id, listing] of queue.slice(0, config.limits.maxNewJobsPerRun)) {
    let detail: Partial<Listing> = {};
    if (!listing.description) {
      try {
        detail = await SOURCES[listing.source].detail(listing);
      } catch (error) {
        summary.failures.push({ where: `${listing.source} detail ${listing.url}`, error: (error as Error).message });
      }
      await sleep(config.limits.detailDelayMs);
    }
    const description = (detail.description ?? listing.description ?? "").slice(0, config.limits.maxDescriptionChars) || null;
    if (!description) continue; // nothing to score against; it will be retried on a later run
    const now = new Date().toISOString();
    const job: Job = {
      id, source: listing.source, sourceId: listing.sourceId, title: listing.title, company: listing.company,
      location: listing.location, url: listing.url, applyUrl: listing.applyUrl, datePosted: listing.datePosted,
      employmentType: detail.employmentType ?? listing.employmentType, remote: listing.remote, description,
      attribution: listing.attribution, firstSeen: now, status: "fetched", history: [{ at: now, status: "fetched" }],
    };
    saveJob(job);
    summary.stored += 1;
  }
  return summary;
}

import { load, type CheerioAPI } from "cheerio";
import type { SearchSpec, SourceName } from "./config.ts";
import { getJson, getText } from "./http.ts";

/** One posting as a source lists it, before it becomes a stored Job. */
export interface Listing {
  source: SourceName;
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
}

export interface Source {
  name: SourceName;
  search(spec: SearchSpec): Promise<Listing[]>;
  /** Full description text (and any fields only the detail page has). */
  detail(listing: Listing): Promise<Partial<Listing>>;
}

const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
};

/** HTML to readable plain text, keeping paragraph and list structure. */
export function htmlToText(html: string): string {
  const $ = load(html);
  $("script, style, noscript, svg, iframe, nav, footer, header form").remove();
  $("br").replaceWith("\n");
  $("li").each((_i, el) => { $(el).prepend("- "); });
  $("p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article").each((_i, el) => { $(el).append("\n"); });
  return $.root().text().replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

// ---------------------------------------------------------------- LinkedIn (public guest endpoints, no login)

export function parseLinkedInSearch(html: string): Listing[] {
  const $ = load(html);
  return $(".base-card").map((_i, el) => {
    const card = $(el);
    const urn = card.attr("data-entity-urn") ?? "";
    const href = card.find("a.base-card__full-link").attr("href") ?? "";
    const sourceId = urn.match(/(\d+)$/)?.[1] ?? href.match(/-(\d+)(?:[/?]|$)/)?.[1];
    const title = clean(card.find(".base-search-card__title").text());
    if (!sourceId || !title) return null;
    const url = `https://www.linkedin.com/jobs/view/${sourceId}/`;
    return {
      source: "linkedin", sourceId, title,
      company: clean(card.find(".base-search-card__subtitle").text()),
      location: clean(card.find(".job-search-card__location").text()),
      url, applyUrl: url,
      datePosted: card.find("time").attr("datetime") ?? null,
      employmentType: null, remote: null, description: null,
      attribution: "LinkedIn",
    } satisfies Listing;
  }).get().filter(Boolean) as Listing[];
}

export function parseLinkedInDetail(html: string): Partial<Listing> {
  const $ = load(html);
  const criteria: Record<string, string> = {};
  $(".description__job-criteria-item").each((_i, el) => {
    const key = clean($(el).find(".description__job-criteria-subheader").text());
    const value = clean($(el).find(".description__job-criteria-text").text());
    if (key && value) criteria[key.toLowerCase()] = value;
  });
  const markup = $(".show-more-less-html__markup").html();
  return {
    description: markup ? htmlToText(markup) : null,
    employmentType: criteria["employment type"] ?? null,
  };
}

const linkedin: Source = {
  name: "linkedin",
  async search(spec) {
    const results: Listing[] = [];
    for (const start of [0, 10, 20]) {
      const url = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
      url.searchParams.set("keywords", spec.keywords);
      if (spec.location) url.searchParams.set("location", spec.location);
      if (spec.contract) url.searchParams.set("f_JT", "C");
      if (spec.remote) url.searchParams.set("f_WT", "2");
      if (spec.maxAgeDays) url.searchParams.set("f_TPR", `r${spec.maxAgeDays * 86_400}`);
      url.searchParams.set("start", String(start));
      const page = parseLinkedInSearch(await getText(url.href));
      results.push(...page);
      if (page.length < 10) break;
    }
    return results;
  },
  async detail(listing) {
    return parseLinkedInDetail(await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${listing.sourceId}`));
  },
};

// ---------------------------------------------------------------- Himalayas (public JSON API)

interface HimalayasJob {
  title: string; companyName?: string; employmentType?: string; description?: string; excerpt?: string;
  locationRestrictions?: string[]; pubDate?: string | number; applicationLink?: string; guid?: string;
}

export function parseHimalayas(payload: { jobs?: HimalayasJob[] }): Listing[] {
  return (payload.jobs ?? []).map((job) => {
    const url = job.guid ?? job.applicationLink ?? "";
    const pub = Number(job.pubDate);
    return {
      source: "himalayas", sourceId: url, title: clean(job.title) ?? "",
      company: clean(job.companyName),
      location: list(job.locationRestrictions).join(", ") || "Remote (worldwide)",
      url, applyUrl: job.applicationLink ?? url,
      datePosted: Number.isFinite(pub) && pub > 0 ? new Date(pub * 1000).toISOString() : null,
      employmentType: clean(job.employmentType), remote: "remote",
      description: job.description ? htmlToText(job.description) : clean(job.excerpt),
      attribution: "Himalayas (himalayas.app)",
    } satisfies Listing;
  }).filter((job) => job.title && job.url);
}

const himalayas: Source = {
  name: "himalayas",
  async search(spec) {
    const url = new URL("https://himalayas.app/jobs/api/search");
    url.searchParams.set("q", spec.keywords);
    if (spec.location) url.searchParams.set("country", spec.location);
    if (spec.contract) url.searchParams.set("employment_type", "Contractor");
    url.searchParams.set("sort", "recent");
    return parseHimalayas(await getJson(url.href));
  },
  async detail() {
    return {}; // the search API already returns the full description
  },
};

// ---------------------------------------------------------------- Jobicy (public JSON API; credit + link back required)

interface JobicyJob {
  id: number | string; url: string; jobTitle: string; companyName?: string; jobType?: string[] | string;
  jobGeo?: string; jobDescription?: string; jobExcerpt?: string; pubDate?: string;
}

export function parseJobicy(payload: { jobs?: JobicyJob[] }): Listing[] {
  return (payload.jobs ?? []).map((job) => ({
    source: "jobicy", sourceId: String(job.id), title: clean(job.jobTitle) ?? "",
    company: clean(job.companyName), location: clean(job.jobGeo),
    url: job.url, applyUrl: job.url, datePosted: job.pubDate ?? null,
    employmentType: list(job.jobType).join(", ") || null, remote: "remote",
    description: job.jobDescription ? htmlToText(job.jobDescription) : clean(job.jobExcerpt),
    attribution: "Jobicy (jobicy.com)",
  } satisfies Listing)).filter((job) => job.title && job.url);
}

const jobicy: Source = {
  name: "jobicy",
  async search(spec) {
    const url = new URL("https://jobicy.com/api/v2/remote-jobs");
    url.searchParams.set("count", "50");
    url.searchParams.set("geo", spec.location ?? "europe");
    url.searchParams.set("industry", "management");
    url.searchParams.set("tag", spec.keywords);
    return parseJobicy(await getJson(url.href));
  },
  async detail() {
    return {};
  },
};

// ---------------------------------------------------------------- Jobs.cz (Czech board; HTML search results)

export function parseJobsCz(html: string): Listing[] {
  const $ = load(html);
  return $("article.SearchResultCard").map((_i, el) => {
    const card = $(el);
    const link = card.find("a.SearchResultCard__titleLink");
    const sourceId = link.attr("data-jobad-id");
    const title = clean(link.text());
    if (!sourceId || !title) return null;
    const url = `https://www.jobs.cz/rpd/${sourceId}/`;
    return {
      source: "jobscz", sourceId, title,
      company: clean(card.find(".SearchResultCard__footerItem [translate='no']").first().text()) ?? clean(card.find(".CompanyLogo img").attr("alt")),
      location: clean(card.find("[data-test='serp-locality']").text()),
      url, applyUrl: url, datePosted: null,
      employmentType: null, remote: card.text().match(/práce z domova|remote/i) ? "partly remote" : null,
      description: null, attribution: "Jobs.cz",
    } satisfies Listing;
  }).get().filter(Boolean) as Listing[];
}

const jobscz: Source = {
  name: "jobscz",
  async search(spec) {
    const place = (spec.location ?? "praha").toLowerCase().replace(/^prague$/, "praha");
    const url = new URL(`https://www.jobs.cz/prace/${encodeURIComponent(place)}/`);
    url.searchParams.append("q[]", spec.keywords);
    return parseJobsCz(await getText(url.href));
  },
  async detail(listing) {
    // Detail pages often redirect to employer-branded career sites, so extract generically.
    return { description: mainText(load(await getText(listing.url))) };
  },
};

// ---------------------------------------------------------------- freelancermap (EU freelance projects; HTML)

export function parseFreelancermap(html: string): Listing[] {
  const $ = load(html);
  return $(".project-card").map((_i, el) => {
    const card = $(el);
    const link = card.find("a[data-id='project-card-title']");
    const href = link.attr("href");
    const title = clean(link.text());
    if (!href || !title) return null;
    const url = new URL(href, "https://www.freelancermap.com").href;
    const field = (name: string) => clean(card.find(`[data-testid='${name}']`).text());
    const city = clean(card.find("[data-id='project-card-city']").text())?.replace(/,$/, "");
    const country = clean(card.find("[data-id='project-card-country']").text());
    return {
      source: "freelancermap", sourceId: href, title,
      company: clean(card.find(".project-info > div").first().text()),
      location: [city, country].filter(Boolean).join(", ") || null,
      url, applyUrl: url, datePosted: null,
      employmentType: [field("type"), field("duration"), field("beginningMonth") ? `start ${field("beginningMonth")}` : null].filter(Boolean).join(", ") || "Freelance",
      remote: field("remoteInPercent"), description: null, attribution: "freelancermap",
    } satisfies Listing;
  }).get().filter(Boolean) as Listing[];
}

const freelancermap: Source = {
  name: "freelancermap",
  async search(spec) {
    const url = new URL(spec.remote ? "https://www.freelancermap.com/projects/remote" : "https://www.freelancermap.com/projects/project-management.html");
    url.searchParams.set("query", spec.keywords);
    return parseFreelancermap(await getText(url.href));
  },
  async detail(listing) {
    return { description: mainText(load(await getText(listing.url))) };
  },
};

/** Best-effort main content of an arbitrary job page. */
function mainText($: CheerioAPI): string | null {
  const ld = $("script[type='application/ld+json']").map((_i, el) => $(el).text()).get();
  for (const raw of ld) {
    try {
      const items = [JSON.parse(raw)].flat(2) as Array<Record<string, unknown>>;
      const posting = items.find((item) => item?.["@type"] === "JobPosting");
      if (typeof posting?.description === "string") return htmlToText(posting.description);
    } catch { /* ignore malformed JSON-LD */ }
  }
  for (const selector of ["[data-test='jd-body-richtext']", ".project-body", ".job-description", "main", "article", "body"]) {
    const html = $(selector).first().html();
    if (html && htmlToText(html).length > 200) return htmlToText(html);
  }
  return null;
}

export const SOURCES: Record<SourceName, Source> = { linkedin, himalayas, jobicy, jobscz, freelancermap };

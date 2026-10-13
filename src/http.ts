const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) jobhunter-pi/0.1 (personal job search; low volume)";

export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET with timeout and a small backoff on 429/5xx. Never retries aggressively. */
export async function getText(url: string, options: { timeoutMs?: number; retries?: number; accept?: string } = {}): Promise<string> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: options.accept ?? "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en,cs;q=0.8" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      redirect: "follow",
    });
    if (response.ok) return response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(`GET ${new URL(url).host} -> ${response.status}`, response.status);
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 2_000 * 2 ** attempt);
  }
}

export async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url, { accept: "application/json" })) as T;
}

import { AtpAgent } from "@atproto/api";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const initialDelay = opts.initialDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 30000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // If rate limited, wait until the reset time
      if (err?.status === 429 && err?.headers?.["ratelimit-reset"]) {
        const resetAt = Number(err.headers["ratelimit-reset"]);
        const waitSec = Math.max(resetAt - Math.floor(Date.now() / 1000), 1);
        console.log(`Rate limited — waiting ${waitSec}s until reset...`);
        await delay(waitSec * 1000 + 1000);
        continue;
      }
      if (attempt < maxRetries) {
        const waitMs = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
        await delay(waitMs);
      }
    }
  }
  throw lastError;
}

export function slugToRkey(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 512);
}

export class PdsClient {
  private agent: AtpAgent;
  private did: string | null = null;
  private writeDelay: number;

  constructor(serviceUrl: string, opts?: { writeDelay?: number }) {
    this.agent = new AtpAgent({ service: serviceUrl });
    this.writeDelay = opts?.writeDelay ?? 100;
  }

  async login(handle: string, password: string) {
    const result = await this.agent.login({ identifier: handle, password });
    this.did = result.data.did;
  }

  getDid(): string {
    if (!this.did) throw new Error("Not logged in");
    return this.did;
  }

  async putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>
  ): Promise<string> {
    if (!this.did) throw new Error("Not logged in");
    const did = this.did;
    const uri = await retryWithBackoff(async () => {
      const result = await this.agent.api.com.atproto.repo.putRecord({
        repo: did,
        collection,
        rkey,
        record,
      });
      return result.data.uri;
    });
    await delay(this.writeDelay);
    return uri;
  }

  async deleteRecord(collection: string, rkey: string): Promise<void> {
    if (!this.did) throw new Error("Not logged in");
    const did = this.did;
    await retryWithBackoff(async () => {
      await this.agent.api.com.atproto.repo.deleteRecord({
        repo: did,
        collection,
        rkey,
      });
    });
    await delay(this.writeDelay);
  }

  makeUri(collection: string, rkey: string): string {
    if (!this.did) throw new Error("Not logged in");
    return `at://${this.did}/${collection}/${rkey}`;
  }
}

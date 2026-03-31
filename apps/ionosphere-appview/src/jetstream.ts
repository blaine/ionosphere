import WebSocket from "ws";
import { IONOSPHERE_COLLECTIONS } from "./indexer.js";
import type { JetstreamEvent } from "./indexer.js";

export interface JetstreamClientOptions {
  url: string;
  wantedCollections?: string[];
  getCursor: () => number | null;
  setCursor: (cursor: number) => void;
  onEvent: (event: JetstreamEvent) => void;
  onError?: (err: Error) => void;
  maxBackoff?: number;
}

export function parseJetstreamMessage(raw: string): JetstreamEvent | null {
  try {
    const parsed = JSON.parse(raw) as JetstreamEvent;
    if (typeof parsed.did !== "string" || typeof parsed.time_us !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildJetstreamUrl(
  baseUrl: string,
  opts: { wantedCollections: string[]; cursor?: number | null }
): string {
  const parts: string[] = [];
  for (const collection of opts.wantedCollections) {
    parts.push(`wantedCollections=${encodeURIComponent(collection)}`);
  }
  if (opts.cursor != null) {
    parts.push(`cursor=${opts.cursor}`);
  }
  return `${baseUrl}/subscribe?${parts.join("&")}`;
}

export class JetstreamClient {
  private opts: JetstreamClientOptions;
  private ws: WebSocket | null = null;
  private _connected = false;
  private stopped = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: JetstreamClientOptions) {
    this.opts = opts;
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws != null) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  private connect(): void {
    if (this.stopped) return;

    const cursor = this.opts.getCursor();
    const url = buildJetstreamUrl(this.opts.url, {
      wantedCollections:
        this.opts.wantedCollections ?? IONOSPHERE_COLLECTIONS,
      cursor,
    });

    console.log(`Jetstream connecting: ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this._connected = true;
      this.backoff = 1000;
      console.log("Jetstream connected");
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const raw = data.toString();
      const event = parseJetstreamMessage(raw);
      if (event == null) return;
      this.opts.onEvent(event);
      this.opts.setCursor(event.time_us);
    });

    ws.on("close", () => {
      this._connected = false;
      this.ws = null;
      console.log("Jetstream disconnected, reconnecting...");
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.opts.onError?.(err);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const maxBackoff = this.opts.maxBackoff ?? 60000;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, maxBackoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

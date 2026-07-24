/**
 * In-process fake strfry relay (spec "Testing strategy" — integration vs mock
 * relays, variant (a)).
 *
 * Plain relay semantics only: no AUTH, no write gating. Serves REQ/EVENT/EOSE,
 * honours `kinds`/`since`/`until`/`limit`, returns newest-first, and can be
 * configured with a hard per-REQ result cap so tests can reproduce the
 * "relay caps the response anyway" case from §4.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

import type { NostrEvent, NostrFilter } from "../../src/types.js";

export interface StrfryMockOptions {
  /** Hard cap on results per REQ, regardless of the client's `limit`. */
  maxEventsPerReq?: number;
}

/** One REQ frame as observed by the mock; tests assert on filter shape. */
export interface ObservedReq {
  subId: string;
  filters: NostrFilter[];
}

interface LiveSub {
  socket: WebSocket;
  subId: string;
  filters: NostrFilter[];
}

/** A scripted directive applied to the next matching REQ(s) by sub-id prefix. */
interface ReqScript {
  prefix: string;
  remaining: number;
  /** "closed" answers the REQ with a CLOSED frame; "stall" never responds. */
  mode: "closed" | "stall";
  message: string;
}

export class StrfryMock {
  /** Every REQ the mock has seen, in order. */
  readonly reqs: ObservedReq[] = [];
  /** Every CLOSE frame the mock has seen, in order. */
  readonly closes: string[] = [];
  /** How many TCP connections the mock has accepted (reconnect assertions). */
  connectionCount = 0;

  private readonly events: NostrEvent[] = [];
  private readonly sockets = new Set<WebSocket>();
  private readonly liveSubs: LiveSub[] = [];
  private readonly maxEventsPerReq: number;
  private readonly scripts: ReqScript[] = [];

  private constructor(
    private readonly wss: WebSocketServer,
    opts: StrfryMockOptions,
  ) {
    this.maxEventsPerReq = opts.maxEventsPerReq ?? Number.POSITIVE_INFINITY;
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  static start(opts: StrfryMockOptions = {}): Promise<StrfryMock> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
        resolve(new StrfryMock(wss, opts));
      });
    });
  }

  get url(): string {
    const addr = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}`;
  }

  /** Seed stored events (hydration fixtures). */
  add(...events: NostrEvent[]): void {
    this.events.push(...events);
  }

  /** Store an event and push it to every matching live sub. */
  broadcast(event: NostrEvent): void {
    this.events.push(event);
    for (const sub of this.liveSubs) {
      if (sub.filters.some((f) => matches(f, event))) {
        send(sub.socket, ["EVENT", sub.subId, event]);
      }
    }
  }

  /** Hard-drop every connection to force the client through its reconnect path. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.liveSubs.length = 0;
  }

  /** REQs whose sub id matches exactly (e.g. the constant live sub id). */
  reqsFor(subId: string): ObservedReq[] {
    return this.reqs.filter((r) => r.subId === subId);
  }

  /** REQs whose sub id starts with `prefix` (paged ids are `<prefix>-<page>`). */
  reqsForPrefix(prefix: string): ObservedReq[] {
    return this.reqs.filter((r) => r.subId.startsWith(prefix));
  }

  /** CLOSE frames received for a given sub id. */
  closesFor(subId: string): string[] {
    return this.closes.filter((s) => s === subId);
  }

  /**
   * Answer the next `count` REQs whose sub id starts with `prefix` with a CLOSED
   * frame instead of serving them (scripts the §4 relay-refusal path).
   */
  closeReqs(
    prefix: string,
    count: number,
    message = "closed: rate-limited",
  ): void {
    this.scripts.push({ prefix, remaining: count, mode: "closed", message });
  }

  /**
   * Swallow the next `count` REQs whose sub id starts with `prefix` — no EVENT,
   * no EOSE, no CLOSED — so the client's page timeout fires.
   */
  stallReqs(prefix: string, count: number): void {
    this.scripts.push({ prefix, remaining: count, mode: "stall", message: "" });
  }

  /** Send a CLOSED frame to every currently-registered live sub with `subId`. */
  closeLiveSubs(subId: string, message = "closed: rate-limited"): void {
    for (const sub of this.liveSubs) {
      if (sub.subId === subId) send(sub.socket, ["CLOSED", sub.subId, message]);
    }
  }

  stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.liveSubs.length = 0;
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(socket: WebSocket): void {
    this.connectionCount += 1;
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.removeSubsFor(socket);
    });
    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

      if (frame[0] === "REQ") {
        const subId = String(frame[1]);
        const filters = frame.slice(2) as NostrFilter[];
        this.reqs.push({ subId, filters });
        const script = this.scripts.find(
          (s) => s.remaining > 0 && subId.startsWith(s.prefix),
        );
        if (script) {
          script.remaining -= 1;
          // "stall" swallows the REQ entirely so the client's timeout fires;
          // "closed" answers with the §4 relay-refusal frame.
          if (script.mode === "closed") {
            send(socket, ["CLOSED", subId, script.message]);
          }
          return;
        }
        for (const event of this.select(filters)) {
          send(socket, ["EVENT", subId, event]);
        }
        send(socket, ["EOSE", subId]);
        this.liveSubs.push({ socket, subId, filters });
        return;
      }

      if (frame[0] === "CLOSE") {
        const subId = String(frame[1]);
        this.closes.push(subId);
        for (let i = this.liveSubs.length - 1; i >= 0; i--) {
          const sub = this.liveSubs[i];
          if (sub && sub.socket === socket && sub.subId === subId) {
            this.liveSubs.splice(i, 1);
          }
        }
        return;
      }

      if (frame[0] === "EVENT") {
        const event = frame[1] as NostrEvent;
        send(socket, ["OK", event.id, true, ""]);
        this.broadcast(event);
      }
    });
  }

  private removeSubsFor(socket: WebSocket): void {
    for (let i = this.liveSubs.length - 1; i >= 0; i--) {
      if (this.liveSubs[i]?.socket === socket) this.liveSubs.splice(i, 1);
    }
  }

  /** Newest-first selection with `limit` applied after ordering, like a relay. */
  private select(filters: NostrFilter[]): NostrEvent[] {
    const out: NostrEvent[] = [];
    for (const filter of filters) {
      const hits = this.events
        .filter((e) => matches(filter, e))
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const cap = Math.min(filter.limit ?? Infinity, this.maxEventsPerReq);
      out.push(...hits.slice(0, cap));
    }
    return out;
  }
}

function send(socket: WebSocket, frame: unknown[]): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export function matches(filter: NostrFilter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    const present = event.tags
      .filter((t) => t[0] === name)
      .map((t) => t[1] ?? "");
    if (!present.some((v) => (values as string[]).includes(v))) return false;
  }
  return true;
}

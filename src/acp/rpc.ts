import type { Readable, Writable } from "node:stream";

export class JsonRpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  cleanup: () => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Minimal JSON-RPC 2.0 connection over newline-delimited JSON streams. */
export class JsonRpcConnection {
  readonly closed: Promise<Error | undefined>;

  private nextId = 1;
  private isClosed = false;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, Set<(params: any) => void>>();
  private readonly requestHandlers = new Map<string, (params: any) => unknown | Promise<unknown>>();
  private resolveClosed!: (reason: Error | undefined) => void;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly trace?: (direction: "out" | "in", line: string) => void,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("end", () => this.close());
    input.on("close", () => this.close());
    input.on("error", (err: Error) => this.close(err));
    output.on("error", (err: Error) => this.close(err));
  }

  request<T>(method: string, params: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error("JSON-RPC connection closed"));
    if (opts.signal?.aborted) return Promise.reject(new Error(`Request ${method} aborted`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`Request ${method} aborted`));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request ${method} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.isClosed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  onNotification(method: string, handler: (params: any) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  onRequest(method: string, handler: (params: any) => unknown | Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  close(reason?: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const err = reason ?? new Error("JSON-RPC connection closed");
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(err);
    }
    this.pending.clear();
    this.resolveClosed(reason);
  }

  private write(message: unknown): void {
    try {
      const line = JSON.stringify(message);
      this.trace?.("out", line);
      this.output.write(`${line}\n`);
    } catch (err) {
      this.close(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    this.trace?.("in", line);
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) this.dispatchNotification(message);
      else void this.dispatchRequest(message);
    } else if (message.id !== undefined) {
      this.dispatchResponse(message);
    }
  }

  private dispatchNotification(message: any): void {
    for (const handler of this.notificationHandlers.get(message.method) ?? []) {
      try {
        handler(message.params);
      } catch {
        // A faulty handler must not break the connection.
      }
    }
  }

  private async dispatchRequest(message: any): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
      return;
    }
    try {
      const result = await handler(message.params);
      if (this.isClosed) return;
      this.write({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (err) {
      if (this.isClosed) return;
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private dispatchResponse(message: any): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    entry.cleanup();
    if (message.error) {
      entry.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
    } else {
      entry.resolve(message.result);
    }
  }
}

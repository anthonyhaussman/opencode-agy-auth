import { createWriteStream, existsSync, mkdirSync, WriteStream } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

export interface ChatLogger {
  logRequest(url: string, method: string, headers: HeadersInit | undefined, body: BodyInit | null | undefined): void;
  logResponseHeaders(status: number, statusText: string, headers: Headers): void;
  logResponseBody(body: string): void;
  createLoggingTransformStream(): TransformStream<Uint8Array, Uint8Array>;
  close(): void;
}

export function createChatLogger(): ChatLogger | null {
  if (process.env.AGY_LOG !== "1") {
    return null;
  }
  try {
    const logDir = join(cwd(), "agy_chat_log");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const timestamp = Date.now();
    const logFile = join(logDir, `${timestamp}.log`);
    const stream = createWriteStream(logFile, { flags: "w", encoding: "utf8" });

    return new ChatLoggerImpl(stream);
  } catch (error) {
    console.error("[Agy Chat Logger] Failed to initialize logger", error);
    return null;
  }
}

class ChatLoggerImpl implements ChatLogger {
  private stream: WriteStream;

  constructor(stream: WriteStream) {
    this.stream = stream;
  }

  logRequest(url: string, method: string, headers: HeadersInit | undefined, body: BodyInit | null | undefined): void {
    this.stream.write(`=========== REQUEST ===========\n`);
    this.stream.write(`[Time] ${new Date().toISOString()}\n`);
    this.stream.write(`[Request] ${method} ${url}\n`);

    if (headers) {
      this.stream.write(`[Headers]\n`);
      const h = new Headers(headers);
      h.forEach((value, key) => {
        // optionally mask token if needed, but since it's for local debug, we might just write it.
        // Let's mask authorization just in case.
        if (key.toLowerCase() === "authorization") {
            this.stream.write(`  ${key}: [redacted]\n`);
        } else {
            this.stream.write(`  ${key}: ${value}\n`);
        }
      });
    }

    this.stream.write(`\n[Body]\n`);
    if (body) {
      if (typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          this.stream.write(JSON.stringify(parsed, null, 2));
        } catch {
          this.stream.write(body);
        }
      } else {
        this.stream.write(`[Non-string body omitted]`);
      }
    } else {
      this.stream.write(`[No body]`);
    }
    this.stream.write(`\n\n`);
  }

  logResponseHeaders(status: number, statusText: string, headers: Headers): void {
    this.stream.write(`=========== RESPONSE ===========\n`);
    this.stream.write(`[Status] ${status} ${statusText}\n`);
    this.stream.write(`[Headers]\n`);
    headers.forEach((value, key) => {
      this.stream.write(`  ${key}: ${value}\n`);
    });
    this.stream.write(`\n[Body / Chunks]\n`);
  }

  logResponseBody(body: string): void {
    this.stream.write(body);
    this.stream.write(`\n\n=========== END ===========\n`);
  }

  createLoggingTransformStream(): TransformStream<Uint8Array, Uint8Array> {
    const stream = this.stream;
    const decoder = new TextDecoder();
    return new TransformStream({
      transform(chunk, controller) {
        stream.write(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush(controller) {
        stream.write(decoder.decode());
        stream.write(`\n\n=========== END ===========\n`);
      }
    });
  }

  close(): void {
    try {
      this.stream.end();
    } catch {}
  }
}

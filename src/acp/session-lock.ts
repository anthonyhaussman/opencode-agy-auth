type Waited<T> = { kind: "done"; value: T } | { kind: "aborted" } | { kind: "timeout" };

/** Waits for `p`, bounded by an optional timeout and abort signal. */
export function waitBounded<T>(p: Promise<T>, signal: AbortSignal | undefined, timeoutMs?: number): Promise<Waited<T>> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise<Waited<T>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ kind: "aborted" });
    function finish(r: Waited<T>) {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    p.then(
      (value) => finish({ kind: "done", value }),
      (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Per pool (shared by every model of one provider), per OpenCode session: tail of the step chain. */
const sessionLocks = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Serializes steps on one OpenCode session. Resolves with a release function,
 * or undefined when `signal` aborted while waiting for the previous step.
 */
export async function lockSession(owner: object, key: string, signal: AbortSignal | undefined) {
  let locks = sessionLocks.get(owner);
  if (!locks) sessionLocks.set(owner, (locks = new Map()));
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  const waited = await waitBounded(previous, signal);
  if (waited.kind !== "done") {
    release();
    return undefined;
  }
  return release;
}

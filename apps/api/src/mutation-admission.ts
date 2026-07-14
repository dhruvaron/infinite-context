/**
 * Process-local read/write admission for API mutations. JavaScript executes
 * each state transition synchronously, so closing admission and removing the
 * upgrading request from the reader set is atomic with respect to new admits.
 */
export class MutationAdmissionGate<Token extends object = object> {
  #accepting = true;
  #admitted = new Set<Token>();
  #exclusive: Token | null = null;
  #drainWaiters = new Set<() => void>();

  admit(token: Token): boolean {
    if (!this.#accepting || this.#exclusive || this.#admitted.has(token)) return false;
    this.#admitted.add(token);
    return true;
  }

  async beginExclusive(token: Token, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.#exclusive || !this.#admitted.has(token)) return false;
    this.#accepting = false;
    this.#exclusive = token;
    this.#admitted.delete(token);
    if (this.#admitted.size === 0) return true;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
    this.#drainWaiters.add(resolveDrain);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new MutationAdmissionDrainError("Mutation admission did not drain before the maintenance deadline.")), timeoutMs);
        }),
        ...(options.signal ? [new Promise<never>((_resolve, reject) => {
          abort = () => reject(new MutationAdmissionDrainError("The maintenance request was aborted while waiting for admitted mutations."));
          if (options.signal!.aborted) abort(); else options.signal!.addEventListener("abort", abort, { once: true });
        })] : [])
      ]);
      return true;
    } catch (error) {
      if (this.#exclusive === token) {
        this.#exclusive = null;
        this.#accepting = true;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort && options.signal) options.signal.removeEventListener("abort", abort);
      this.#drainWaiters.delete(resolveDrain);
    }
  }

  release(token: Token): void {
    if (!this.#admitted.delete(token) || this.#admitted.size > 0) return;
    const waiters = [...this.#drainWaiters];
    this.#drainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  endExclusive(token: Token): boolean {
    if (this.#exclusive !== token) return false;
    this.#exclusive = null;
    this.#accepting = true;
    return true;
  }

  get activeMutations(): number { return this.#admitted.size; }
  get maintenanceActive(): boolean { return this.#exclusive !== null; }
}

export class MutationAdmissionDrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationAdmissionDrainError";
  }
}

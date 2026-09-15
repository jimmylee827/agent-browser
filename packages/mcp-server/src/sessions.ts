/**
 * Named-session registry with per-session mutex so two agents can't drive the
 * same tab concurrently. Tab/profile binding is added with the engine (task #5+).
 */
export class SessionManager {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(session: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(session) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(
      session,
      prev.then(() => next),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(session) === next) this.locks.delete(session);
    }
  }
}

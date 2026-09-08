import type { TaskMutationLock } from './types.js'

/** Serializes async task mutations without holding a lock across processes. */
export class AsyncTaskMutationLock implements TaskMutationLock {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

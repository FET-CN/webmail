/** Serializes mailbox provisioning for one stable IAM identity. */
export interface ProvisioningCoordinator {
  run<T>(key: string, action: () => Promise<T>): Promise<T>;
}

/** Process-local coordinator used by tests and single-process deployments. */
export class MemoryProvisioningCoordinator implements ProvisioningCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => release = resolve);
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

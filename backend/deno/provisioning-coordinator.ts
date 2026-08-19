import type { ProvisioningCoordinator } from "../core/provisioning-coordinator.ts";

interface Lease {
  token: string;
  expiresAt: number;
}

/**
 * Uses Deno KV versionstamps to serialize provisioning across Deno instances.
 * Leases expire so a terminated process cannot permanently block an identity.
 */
export class DenoKvProvisioningCoordinator implements ProvisioningCoordinator {
  constructor(
    private readonly kv: Deno.Kv,
    private readonly leaseMilliseconds = 120_000,
    private readonly waitMilliseconds = 30_000,
  ) {}

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    const kvKey: Deno.KvKey = ["mailecho", "provisioning-lock", key];
    const deadline = Date.now() + this.waitMilliseconds;
    while (true) {
      const current = await this.kv.get<Lease>(kvKey);
      if (!current.value || current.value.expiresAt <= Date.now()) {
        const lease: Lease = {
          token,
          expiresAt: Date.now() + this.leaseMilliseconds,
        };
        const committed = await this.kv.atomic()
          .check(current)
          .set(kvKey, lease, { expireIn: this.leaseMilliseconds })
          .commit();
        if (committed.ok) break;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the mailbox provisioning lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      return await action();
    } finally {
      const current = await this.kv.get<Lease>(kvKey);
      if (current.value?.token === token) {
        await this.kv.atomic().check(current).delete(kvKey).commit();
      }
    }
  }
}

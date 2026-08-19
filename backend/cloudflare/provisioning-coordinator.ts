import type { ProvisioningCoordinator } from "../core/provisioning-coordinator.ts";

interface Lease {
  token: string;
  expiresAt: number;
}

interface DurableObjectTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectStateLike {
  storage: {
    transaction<T>(
      closure: (transaction: DurableObjectTransactionLike) => Promise<T>,
    ): Promise<T>;
  };
}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** Durable Object that owns the lease for one stable IAM identity. */
export class ProvisioningLockObject {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const token = request.headers.get("x-lock-token") || "";
    if (!token) return new Response("Missing lock token", { status: 400 });
    if (request.method === "PUT") {
      const acquired = await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<Lease>("lease");
        if (current && current.expiresAt > Date.now()) return false;
        await storage.put(
          "lease",
          {
            token,
            expiresAt: Date.now() + 120_000,
          } satisfies Lease,
        );
        return true;
      });
      return new Response(null, { status: acquired ? 204 : 409 });
    }
    if (request.method === "DELETE") {
      await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<Lease>("lease");
        if (current?.token === token) await storage.delete("lease");
      });
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

/** Acquires an identity-scoped Durable Object lease around provisioning. */
export class CloudflareProvisioningCoordinator
  implements ProvisioningCoordinator {
  constructor(
    private readonly namespace: DurableObjectNamespaceLike,
    private readonly waitMilliseconds = 30_000,
  ) {}

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    const stub = this.namespace.get(this.namespace.idFromName(key));
    const deadline = Date.now() + this.waitMilliseconds;
    while (true) {
      const response = await stub.fetch(
        new Request("https://lock/acquire", {
          method: "PUT",
          headers: { "x-lock-token": token },
        }),
      );
      if (response.status === 204) break;
      if (response.status !== 409 || Date.now() >= deadline) {
        throw new Error("Timed out waiting for the mailbox provisioning lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      return await action();
    } finally {
      await stub.fetch(
        new Request("https://lock/release", {
          method: "DELETE",
          headers: { "x-lock-token": token },
        }),
      ).catch(() => undefined);
    }
  }
}

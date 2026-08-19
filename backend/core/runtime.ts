import type { BackendConfig } from "./config.ts";
import type { CredentialStore } from "./credential-store.ts";
import type { DirectoryStore } from "./directory-store.ts";
import type { EventHub } from "./events.ts";
import type { LocalMessageStore } from "./local-messages.ts";
import type { MigaduAdmin } from "./migadu.ts";
import type { ProvisioningCoordinator } from "./provisioning-coordinator.ts";
import type { KeyValueStore } from "./session-kv.ts";
import type { SessionStore } from "./session.ts";
import type { ByteDuplex } from "../protocol/transport.ts";

/** Runtime-owned dependencies consumed by the shared HTTP and protocol core. */
export interface RuntimeAdapter {
  config: BackendConfig;
  sessions: SessionStore;
  directory: DirectoryStore;
  credentials: CredentialStore;
  oidcStorage: KeyValueStore;
  migaduAdmin: MigaduAdmin;
  localMessages: LocalMessageStore;
  provisioning: ProvisioningCoordinator;
  events?: EventHub;
  connectImap(): Promise<ByteDuplex>;
  connectSmtp(): Promise<ByteDuplex>;
}

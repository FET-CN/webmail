import { AppError } from "./errors.ts";
import type { OidcIdentity } from "./oidc.ts";
import { generatedLocalPart, randomSecret } from "./migadu.ts";
import type {
  MailboxCredential,
  MailboxGrant,
  MailboxRecord,
  WebmailUser,
} from "./domain.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { SessionService } from "./session.ts";
import { authenticateRequest } from "./request-auth.ts";

export interface ProvisionedMailbox {
  user: WebmailUser;
  mailbox: MailboxRecord;
  credential: MailboxCredential;
  grant: MailboxGrant;
}

export interface MailboxSelectionRequired {
  needsMailboxSelection: true;
  suggestedAddress: string;
  user: WebmailUser;
}

export type ProvisionResult = ProvisionedMailbox | MailboxSelectionRequired;

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Generates a provider-free suggested address for JIT collision fallback. */
export async function generateSuggestedAddress(
  runtime: RuntimeAdapter,
  localPart: string,
): Promise<string> {
  const domain = runtime.config.mailDomain;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${localPart}-${randomSuffix()}`;
    const address = `${candidate}@${domain}`;
    if (await runtime.directory.getMailboxByAddress(address)) continue;
    if (await runtime.directory.getMailboxByInternalAddress(address)) continue;
    const remote = await runtime.migaduAdmin.getMailbox(candidate, domain);
    if (remote) continue;
    return address;
  }
  const fallback = `${localPart}-${randomSuffix()}${randomSuffix()}`;
  return `${fallback}@${domain}`;
}

function internalAddress(localPart: string, runtime: RuntimeAdapter): string {
  const domain = runtime.config.internalMailDomain;
  if (
    !domain || domain.toLowerCase() === runtime.config.mailDomain.toLowerCase()
  ) {
    throw new AppError(
      "PROVISIONING_UNAVAILABLE",
      "A distinct internal mail domain is required for mailbox provisioning.",
    );
  }
  return `${localPart}@${domain}`;
}

async function addInternalAddress(
  mailbox: MailboxRecord,
  runtime: RuntimeAdapter,
): Promise<void> {
  if (mailbox.internalAddress) return;
  const address = internalAddress(mailbox.localPart, runtime);
  const assigned = await runtime.directory.getMailboxByInternalAddress(address);
  if (assigned && assigned.id !== mailbox.id) {
    throw new AppError(
      "PROVISIONING_UNAVAILABLE",
      "The internal mailbox address is already assigned.",
    );
  }
  const publicAssigned = await runtime.directory.getMailboxByAddress(address);
  if (publicAssigned && publicAssigned.id !== mailbox.id) {
    throw new AppError(
      "PROVISIONING_UNAVAILABLE",
      "The internal mailbox address conflicts with a public mailbox.",
    );
  }
  mailbox.internalAddress = address;
  mailbox.updatedAt = new Date().toISOString();
  await runtime.directory.putMailbox(mailbox);
}

/**
 * Creates the Migadu mailbox, backend-only identity, encrypted credential, and
 * local directory records as one compensating operation.
 */
export function createManagedMailbox(
  runtime: RuntimeAdapter,
  input: {
    localPart: string;
    domain: string;
    name: string;
    ownerUserId: string;
    createdBy: string;
  },
): Promise<{ mailbox: MailboxRecord; credential: MailboxCredential }> {
  const key = "mailbox:" + input.domain.toLowerCase() + ":" +
    input.localPart.toLowerCase();
  return runtime.provisioning.run(
    key,
    () => createManagedMailboxLocked(runtime, input),
  );
}

async function createManagedMailboxLocked(
  runtime: RuntimeAdapter,
  input: {
    localPart: string;
    domain: string;
    name: string;
    ownerUserId: string;
    createdBy: string;
  },
): Promise<{ mailbox: MailboxRecord; credential: MailboxCredential }> {
  const now = new Date().toISOString();
  const mailboxId = crypto.randomUUID();
  const address = `${input.localPart}@${input.domain}`;
  if (
    input.domain.toLowerCase() === runtime.config.internalMailDomain.toLowerCase()
  ) {
    throw new AppError(
      "INVALID_PARAMS",
      "The public mailbox domain cannot be the internal mail domain.",
      "domain",
    );
  }
  if (await runtime.directory.getMailboxByAddress(address)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The mailbox address is already assigned.",
      "local_part",
    );
  }
  if (await runtime.directory.getMailboxByInternalAddress(address)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The mailbox address is already assigned internally.",
      "local_part",
    );
  }
  const internal = internalAddress(input.localPart, runtime);
  if (await runtime.directory.getMailboxByInternalAddress(internal)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The internal mailbox address is already assigned.",
      "local_part",
    );
  }
  if (await runtime.directory.getMailboxByAddress(internal)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The internal mailbox address conflicts with a public mailbox.",
      "local_part",
    );
  }
  let mailbox: MailboxRecord | null = null;
  let credential: MailboxCredential | null = null;
  let remoteLocalPart: string | null = null;
  let remoteIdentityLocalPart: string | null = null;
  try {
    const remote = await runtime.migaduAdmin.createMailbox(
      input.localPart,
      input.domain,
      input.name,
      randomSecret(),
    );
    remoteLocalPart = remote.local_part || input.localPart;
    mailbox = {
      id: mailboxId,
      address: remote.address || `${input.localPart}@${input.domain}`,
      internalAddress: internal,
      localPart: input.localPart,
      domain: input.domain,
      state: "active",
      ownerUserId: input.ownerUserId,
      localDeliveryEnabled: true,
      migaduLocalPart: remoteLocalPart,
      createdAt: now,
      updatedAt: now,
    };
    remoteIdentityLocalPart = `webmail_${
      mailboxId.replaceAll("-", "").slice(0, 20)
    }`;
    const backendIdentity = await runtime.migaduAdmin.createBackendIdentity(
      remoteIdentityLocalPart,
      input.domain,
      remoteLocalPart,
      "webmail backend",
    );
    credential = {
      id: crypto.randomUUID(),
      mailboxId,
      username: backendIdentity.address,
      password: backendIdentity.password,
      keyVersion: 1,
      createdAt: now,
    };
    mailbox.credentialId = credential.id;
    await runtime.credentials.put(credential);
    await runtime.directory.putMailbox(mailbox);
    await runtime.directory.putGrant({
      userId: input.ownerUserId,
      mailboxId,
      role: "owner",
      createdAt: now,
      createdBy: input.createdBy,
    });
    return { mailbox, credential };
  } catch (error) {
    await runtime.directory.deleteGrant(input.ownerUserId, mailboxId).catch(
      () => undefined,
    );
    if (mailbox) {
      await runtime.directory.deleteMailbox(mailbox).catch(() => undefined);
    }
    if (credential) {
      await runtime.credentials.delete(credential.id).catch(() => undefined);
    }
    if (remoteIdentityLocalPart && remoteLocalPart) {
      await runtime.migaduAdmin.deleteBackendIdentity(
        remoteIdentityLocalPart,
        input.domain,
        remoteLocalPart,
      ).catch(() => undefined);
    }
    if (remoteLocalPart) {
      await runtime.migaduAdmin.deleteMailbox(remoteLocalPart, input.domain)
        .catch(() => undefined);
    }
    throw error;
  }
}

/** Provisions or resolves the stable primary mailbox for an Authentik subject. */
export function provision(
  identity: OidcIdentity,
  runtime: RuntimeAdapter,
): Promise<ProvisionResult> {
  const lockKey = `${identity.issuer}\0${identity.subject}`;
  return runtime.provisioning.run(lockKey, async () => {
    const now = new Date().toISOString();
    const existingUser = await runtime.directory.getUserByIdentity(
      identity.issuer,
      identity.subject,
    );
    const user: WebmailUser = existingUser || {
      id: crypto.randomUUID(),
      issuer: identity.issuer,
      subject: identity.subject,
      preferredUsername: identity.preferredUsername,
      email: identity.email,
      groups: identity.groups,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    if (existingUser && !existingUser.enabled) {
      throw new AppError("FORBIDDEN", "The webmail identity is disabled.");
    }
    user.preferredUsername = identity.preferredUsername;
    user.email = identity.email;
    user.groups = identity.groups;
    user.updatedAt = now;
    await runtime.directory.putUser(user);

    const localPart = generatedLocalPart(user.preferredUsername);
    const address = `${localPart}@${runtime.config.mailDomain}`;
    let mailbox = user.primaryMailboxId
      ? await runtime.directory.getMailbox(user.primaryMailboxId)
      : await runtime.directory.getMailboxByAddress(address);
    let credential: MailboxCredential | null = null;
    if (!mailbox) {
      if (
        !runtime.config.mailboxProvisioningEnabled ||
        !runtime.config.mailDomain
      ) {
        throw new AppError(
          "PROVISIONING_UNAVAILABLE",
          "Mailbox provisioning is not enabled.",
        );
      }
      try {
        const created = await createManagedMailbox(runtime, {
          localPart,
          domain: runtime.config.mailDomain,
          name: `webmail ${user.preferredUsername}`,
          ownerUserId: user.id,
          createdBy: user.id,
        });
        mailbox = created.mailbox;
        credential = created.credential;
        user.primaryMailboxId = mailbox.id;
        user.updatedAt = new Date().toISOString();
        try {
          await runtime.directory.putUser(user);
        } catch (error) {
          await runtime.directory.deleteGrant(user.id, mailbox.id).catch(
            () => undefined,
          );
          await runtime.directory.deleteMailbox(mailbox).catch(() => undefined);
          await runtime.credentials.delete(credential.id).catch(
            () => undefined,
          );
          await runtime.migaduAdmin.deleteBackendIdentity(
            credential.username.split("@", 1)[0],
            mailbox.domain,
            mailbox.migaduLocalPart || mailbox.localPart,
          ).catch(() => undefined);
          await runtime.migaduAdmin.deleteMailbox(
            mailbox.migaduLocalPart || mailbox.localPart,
            mailbox.domain,
          ).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        // A raced claim/registration may have bound the address while we were
        // creating it, or Migadu may already host it. Guide the user instead
        // of failing the login.
        if (await runtime.directory.getMailboxByAddress(address)) {
          const suggestedAddress = await generateSuggestedAddress(
            runtime,
            localPart,
          );
          return { needsMailboxSelection: true, suggestedAddress, user };
        }
        throw error;
      }
    }
    if (mailbox.state !== "active") {
      throw new AppError("FORBIDDEN", "The mailbox is not active.");
    }
    await addInternalAddress(mailbox, runtime);
    let grant = await runtime.directory.getGrant(user.id, mailbox.id);
    if (!grant) {
      if (mailbox.ownerUserId !== user.id) {
        const suggestedAddress = await generateSuggestedAddress(
          runtime,
          localPart,
        );
        return { needsMailboxSelection: true, suggestedAddress, user };
      }
      grant = {
        userId: user.id,
        mailboxId: mailbox.id,
        role: "owner",
        createdAt: now,
        createdBy: user.id,
      };
      await runtime.directory.putGrant(grant);
    }
    if (!mailbox.credentialId) {
      throw new AppError(
        "PROVISIONING_UNAVAILABLE",
        "The mailbox backend credential is missing.",
      );
    }
    credential ||= await runtime.credentials.get(mailbox.credentialId);
    if (!credential) {
      throw new AppError(
        "PROVISIONING_UNAVAILABLE",
        "The mailbox backend credential is unavailable.",
      );
    }
    return { user, mailbox, credential, grant };
  });
}

export async function requireMailboxAccess(
  identity: Awaited<ReturnType<typeof authenticateRequest>>,
  runtime: RuntimeAdapter,
): Promise<{ mailbox: MailboxRecord; credential: MailboxCredential }> {
  const user = await runtime.directory.getUser(identity.record.userId);
  if (
    !user?.enabled || !user.groups.includes(runtime.config.oidcWebmailGroup)
  ) {
    throw new AppError(
      "FORBIDDEN",
      "The identity is not allowed to use webmail.",
    );
  }
  const mailboxId = identity.record.mailboxId;
  if (!mailboxId) {
    throw new AppError("MAILBOX_NOT_FOUND", "The mailbox is unavailable.");
  }
  const mailbox = await runtime.directory.getMailbox(mailboxId);
  if (!mailbox || mailbox.state !== "active") {
    throw new AppError("MAILBOX_NOT_FOUND", "The mailbox is unavailable.");
  }
  const grant = await runtime.directory.getGrant(
    identity.record.userId,
    mailbox.id,
  );
  if (!grant) {
    throw new AppError(
      "FORBIDDEN",
      "The user is not allowed to access this mailbox.",
    );
  }
  await addInternalAddress(mailbox, runtime);
  if (!mailbox.credentialId) {
    throw new AppError(
      "PROVISIONING_UNAVAILABLE",
      "The mailbox backend credential is missing.",
    );
  }
  const credential = await runtime.credentials.get(mailbox.credentialId);
  if (!credential) {
    throw new AppError(
      "PROVISIONING_UNAVAILABLE",
      "The mailbox backend credential is unavailable.",
    );
  }
  return { mailbox, credential };
}

export async function authenticateProtocolRequest(
  request: Request,
  runtime: RuntimeAdapter,
  protocol: "imap" | "smtp",
): Promise<{
  username: string;
  password: string;
  protocol: "imap" | "smtp";
  identityExpiresAt: number;
}> {
  const identity = await authenticateRequest(
    request,
    new SessionService(runtime.sessions, runtime.config),
  );
  const access = await requireMailboxAccess(identity, runtime);
  return {
    username: access.credential.username,
    password: access.credential.password,
    protocol,
    identityExpiresAt: identity.record.identityValidatedAt +
      runtime.config.oidcReauthSeconds * 1000,
  };
}

export async function requireAdmin(
  identity: Awaited<ReturnType<typeof authenticateRequest>>,
  runtime: RuntimeAdapter,
): Promise<WebmailUser> {
  const user = await runtime.directory.getUser(identity.record.userId);
  if (!user?.enabled || !user.groups.includes(runtime.config.oidcAdminGroup)) {
    throw new AppError("FORBIDDEN", "Administrator access is required.");
  }
  return user;
}

/**
 * Authenticates a webmail user without requiring a selected mailbox. Used by
 * registration/claim endpoints, which must be reachable by a mailbox-less
 * identity during the first-login selection flow.
 */
export async function requireWebmailUser(
  identity: Awaited<ReturnType<typeof authenticateRequest>>,
  runtime: RuntimeAdapter,
): Promise<WebmailUser> {
  const user = await runtime.directory.getUser(identity.record.userId);
  if (!user?.enabled || !user.groups.includes(runtime.config.oidcWebmailGroup)) {
    throw new AppError(
      "FORBIDDEN",
      "The identity is not allowed to use webmail.",
    );
  }
  return user;
}

/**
 * Picks a mailbox+credential pair to send verification mail from. Prefers the
 * primary mailbox, then any active mailbox with a grant and credential.
 */
export async function pickSenderMailbox(
  runtime: RuntimeAdapter,
  user: WebmailUser,
): Promise<{ mailbox: MailboxRecord; credential: MailboxCredential }> {
  const candidateIds: string[] = [];
  if (user.primaryMailboxId) candidateIds.push(user.primaryMailboxId);
  for (const grant of await runtime.directory.listGrantsForUser(user.id)) {
    if (!candidateIds.includes(grant.mailboxId)) {
      candidateIds.push(grant.mailboxId);
    }
  }
  for (const mailboxId of candidateIds) {
    const mailbox = await runtime.directory.getMailbox(mailboxId);
    if (!mailbox || mailbox.state !== "active" || !mailbox.credentialId) {
      continue;
    }
    const credential = await runtime.credentials.get(mailbox.credentialId);
    if (!credential) continue;
    return { mailbox, credential };
  }
  throw new AppError(
    "PROVISIONING_UNAVAILABLE",
    "No active mailbox is available to send verification mail.",
  );
}

/**
 * Attaches a Migadu mailbox that already exists at the provider to a webmail
 * identity: creates a backend identity, encrypted credential, directory record,
 * and owner grant. Unlike createManagedMailbox, it never creates (or, on
 * failure, deletes) the remote mailbox itself.
 */
export function attachClaimedMailbox(
  runtime: RuntimeAdapter,
  input: {
    address: string;
    ownerUserId: string;
    createdBy: string;
  },
): Promise<{ mailbox: MailboxRecord; credential: MailboxCredential }> {
  const at = input.address.lastIndexOf("@");
  const localPart = input.address.slice(0, at).toLowerCase();
  const domain = input.address.slice(at + 1).toLowerCase();
  const key = "mailbox:" + domain + ":" + localPart;
  return runtime.provisioning.run(key, () =>
    attachClaimedMailboxLocked(runtime, { ...input, localPart, domain })
  );
}

async function attachClaimedMailboxLocked(
  runtime: RuntimeAdapter,
  input: {
    address: string;
    ownerUserId: string;
    createdBy: string;
    localPart: string;
    domain: string;
  },
): Promise<{ mailbox: MailboxRecord; credential: MailboxCredential }> {
  const now = new Date().toISOString();
  const mailboxId = crypto.randomUUID();
  const address = `${input.localPart}@${input.domain}`;
  if (
    input.domain.toLowerCase() === runtime.config.internalMailDomain.toLowerCase()
  ) {
    throw new AppError(
      "INVALID_PARAMS",
      "The public mailbox domain cannot be the internal mail domain.",
      "domain",
    );
  }
  if (await runtime.directory.getMailboxByAddress(address)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The mailbox address is already assigned.",
    );
  }
  if (await runtime.directory.getMailboxByInternalAddress(address)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The mailbox address is already assigned internally.",
    );
  }
  const internal = internalAddress(input.localPart, runtime);
  if (await runtime.directory.getMailboxByInternalAddress(internal)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The internal mailbox address is already assigned.",
    );
  }
  if (await runtime.directory.getMailboxByAddress(internal)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The internal mailbox address conflicts with a public mailbox.",
    );
  }
  const remote = await runtime.migaduAdmin.getMailbox(
    input.localPart,
    input.domain,
  );
  if (!remote) {
    throw new AppError(
      "ADDRESS_UNAVAILABLE",
      "The mailbox does not exist at the provider.",
    );
  }
  const remoteLocalPart = remote.local_part || input.localPart;
  let mailbox: MailboxRecord | null = null;
  let credential: MailboxCredential | null = null;
  let remoteIdentityLocalPart: string | null = null;
  try {
    remoteIdentityLocalPart = `webmail_${
      mailboxId.replaceAll("-", "").slice(0, 20)
    }`;
    const backendIdentity = await runtime.migaduAdmin.createBackendIdentity(
      remoteIdentityLocalPart,
      input.domain,
      remoteLocalPart,
      "webmail backend",
    );
    credential = {
      id: crypto.randomUUID(),
      mailboxId,
      username: backendIdentity.address,
      password: backendIdentity.password,
      keyVersion: 1,
      createdAt: now,
    };
    mailbox = {
      id: mailboxId,
      address: remote.address || address,
      internalAddress: internal,
      localPart: input.localPart,
      domain: input.domain,
      state: "active",
      ownerUserId: input.ownerUserId,
      localDeliveryEnabled: true,
      migaduLocalPart: remoteLocalPart,
      credentialId: credential.id,
      createdAt: now,
      updatedAt: now,
    };
    await runtime.credentials.put(credential);
    await runtime.directory.putMailbox(mailbox);
    await runtime.directory.putGrant({
      userId: input.ownerUserId,
      mailboxId,
      role: "owner",
      createdAt: now,
      createdBy: input.createdBy,
    });
    return { mailbox, credential };
  } catch (error) {
    await runtime.directory.deleteGrant(input.ownerUserId, mailboxId).catch(
      () => undefined,
    );
    if (mailbox) {
      await runtime.directory.deleteMailbox(mailbox).catch(() => undefined);
    }
    if (credential) {
      await runtime.credentials.delete(credential.id).catch(() => undefined);
    }
    if (remoteIdentityLocalPart) {
      await runtime.migaduAdmin.deleteBackendIdentity(
        remoteIdentityLocalPart,
        input.domain,
        remoteLocalPart,
      ).catch(() => undefined);
    }
    // The remote mailbox pre-exists and belongs to its owner; never delete it.
    throw error;
  }
}

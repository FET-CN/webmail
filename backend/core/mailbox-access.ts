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
): Promise<ProvisionedMailbox> {
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
        await runtime.credentials.delete(credential.id).catch(() => undefined);
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
    }
    if (mailbox.state !== "active") {
      throw new AppError("FORBIDDEN", "The mailbox is not active.");
    }
    await addInternalAddress(mailbox, runtime);
    let grant = await runtime.directory.getGrant(user.id, mailbox.id);
    if (!grant) {
      if (mailbox.ownerUserId !== user.id) {
        throw new AppError(
          "FORBIDDEN",
          "The mailbox address is already assigned to another identity.",
        );
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
  const mailbox = await runtime.directory.getMailbox(identity.record.mailboxId);
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

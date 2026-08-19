import type { MailboxCredential, MailboxRecord } from "./domain.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { AppError } from "./errors.ts";

export type MailboxLifecycleAction =
  | "suspend"
  | "restore"
  | "rotate-credential"
  | "schedule-delete"
  | "cancel-delete";

function isOperational(mailbox: MailboxRecord): boolean {
  return mailbox.state === "active" || mailbox.state === "suspended";
}

/**
 * Applies the admin-visible state transition without persistence or remote
 * effects. Deletion is intentionally terminal: recreating a deleted mailbox
 * must be an explicit provisioning operation rather than a state flip.
 */
export function applyMailboxLifecycleAction(
  mailbox: MailboxRecord,
  action: MailboxLifecycleAction,
  now = Date.now(),
): void {
  if (mailbox.state === "deleted") {
    throw new AppError(
      "INVALID_PARAMS",
      "A deleted mailbox cannot be changed.",
      "action",
    );
  }
  if (action === "cancel-delete") {
    if (mailbox.state !== "pending_delete") {
      throw new AppError(
        "INVALID_PARAMS",
        "Only a pending mailbox can cancel deletion.",
        "action",
      );
    }
    if (mailbox.deletionIdentityRemoved || mailbox.deletionMailboxRemoved) {
      throw new AppError(
        "INVALID_PARAMS",
        "Deletion has already started and cannot be canceled.",
        "action",
      );
    }
    mailbox.state = "active";
    delete mailbox.deleteAfter;
    return;
  }
  if (mailbox.state === "pending_delete") {
    throw new AppError(
      "INVALID_PARAMS",
      "Cancel deletion before applying another lifecycle action.",
      "action",
    );
  }
  if (!isOperational(mailbox)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The mailbox is not ready for this lifecycle action.",
      "action",
    );
  }
  if (action === "suspend") {
    mailbox.state = "suspended";
    return;
  }
  if (action === "restore") {
    mailbox.state = "active";
    return;
  }
  if (action === "schedule-delete") {
    mailbox.state = "pending_delete";
    mailbox.deleteAfter = new Date(
      now + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
}

/** Applies a normal admin PATCH without bypassing the deletion lifecycle. */
export function setMailboxOperationalState(
  mailbox: MailboxRecord,
  state: "active" | "suspended",
): void {
  if (!isOperational(mailbox)) {
    throw new AppError(
      "INVALID_PARAMS",
      mailbox.state === "pending_delete"
        ? "Use the cancel-delete action to restore a pending mailbox."
        : "The mailbox is not available for a direct state change.",
      "state",
    );
  }
  mailbox.state = state;
}

export function audit(
  runtime: RuntimeAdapter,
  actorUserId: string,
  action: string,
  detail: Record<string, unknown> = {},
  mailboxId?: string,
  targetUserId?: string,
): Promise<void> {
  return runtime.directory.appendAudit({
    id: crypto.randomUUID(),
    actorUserId,
    action,
    ...(mailboxId ? { mailboxId } : {}),
    ...(targetUserId ? { targetUserId } : {}),
    detail,
    createdAt: new Date().toISOString(),
  });
}

async function deleteRemoteIdentity(
  runtime: RuntimeAdapter,
  mailbox: MailboxRecord,
  credential: MailboxCredential,
): Promise<void> {
  await runtime.migaduAdmin.deleteBackendIdentity(
    credential.username.split("@", 1)[0],
    mailbox.domain,
    mailbox.migaduLocalPart || mailbox.localPart,
  );
}

async function reconcileRetiredCredentials(
  runtime: RuntimeAdapter,
  mailbox: MailboxRecord,
): Promise<void> {
  for (const credentialId of mailbox.retiredCredentialIds || []) {
    const credential = await runtime.credentials.get(credentialId);
    if (credential) {
      await deleteRemoteIdentity(runtime, mailbox, credential);
      await runtime.credentials.delete(credential.id);
    }
    mailbox.retiredCredentialIds = (mailbox.retiredCredentialIds || []).filter(
      (id) => id !== credentialId,
    );
    mailbox.updatedAt = new Date().toISOString();
    await runtime.directory.putMailbox(mailbox);
  }
}

/**
 * Switches the mailbox to a newly persisted identity before retiring the old
 * one, so a cleanup failure cannot lock the webmail backend out of Migadu.
 */
export async function rotateMailboxCredential(
  runtime: RuntimeAdapter,
  mailbox: MailboxRecord,
): Promise<void> {
  const old = mailbox.credentialId
    ? await runtime.credentials.get(mailbox.credentialId)
    : null;
  const identity = await runtime.migaduAdmin.createBackendIdentity(
    `_webmail_${mailbox.id.replaceAll("-", "").slice(0, 20)}_${
      Date.now().toString(36)
    }`,
    mailbox.domain,
    mailbox.migaduLocalPart || mailbox.localPart,
    "webmail backend",
  );
  const credential: MailboxCredential = {
    id: crypto.randomUUID(),
    mailboxId: mailbox.id,
    username: identity.address,
    password: identity.password,
    keyVersion: (old?.keyVersion || 0) + 1,
    createdAt: new Date().toISOString(),
  };
  try {
    await runtime.credentials.put(credential);
    mailbox.credentialId = credential.id;
    if (old) {
      mailbox.retiredCredentialIds = [
        ...(mailbox.retiredCredentialIds || []),
        old.id,
      ];
    }
    mailbox.updatedAt = new Date().toISOString();
    await runtime.directory.putMailbox(mailbox);
  } catch (error) {
    await runtime.credentials.delete(credential.id).catch(() => undefined);
    await deleteRemoteIdentity(runtime, mailbox, credential).catch(
      () => undefined,
    );
    throw error;
  }
  await reconcileRetiredCredentials(runtime, mailbox).catch(() => undefined);
}

/**
 * Reconciles retired identities and due mailbox deletions. Every external
 * delete accepts provider 404, and local progress is persisted after each
 * stage so scheduled retries are safe.
 */
export async function reconcileMailboxLifecycle(
  runtime: RuntimeAdapter,
  actorUserId = "system:lifecycle",
  now = Date.now(),
): Promise<void> {
  for (const mailbox of await runtime.directory.listMailboxes()) {
    await reconcileRetiredCredentials(runtime, mailbox);
    if (
      mailbox.state !== "pending_delete" || !mailbox.deleteAfter ||
      Date.parse(mailbox.deleteAfter) > now
    ) continue;

    const credential = mailbox.credentialId
      ? await runtime.credentials.get(mailbox.credentialId)
      : null;
    if (!mailbox.deletionIdentityRemoved && credential) {
      await deleteRemoteIdentity(runtime, mailbox, credential);
      mailbox.deletionIdentityRemoved = true;
      mailbox.updatedAt = new Date().toISOString();
      await runtime.directory.putMailbox(mailbox);
    }
    if (credential) await runtime.credentials.delete(credential.id);
    delete mailbox.credentialId;

    if (!mailbox.deletionMailboxRemoved) {
      await runtime.migaduAdmin.deleteMailbox(
        mailbox.migaduLocalPart || mailbox.localPart,
        mailbox.domain,
      );
      mailbox.deletionMailboxRemoved = true;
      mailbox.deletionIdentityRemoved = true;
      mailbox.updatedAt = new Date().toISOString();
      await runtime.directory.putMailbox(mailbox);
    }
    for (
      const grant of await runtime.directory.listGrantsForMailbox(mailbox.id)
    ) {
      await runtime.directory.deleteGrant(grant.userId, mailbox.id);
    }
    mailbox.state = "deleted";
    delete mailbox.deleteAfter;
    mailbox.updatedAt = new Date().toISOString();
    await runtime.directory.putMailbox(mailbox);
    await audit(runtime, actorUserId, "mailbox.deleted", {}, mailbox.id);
  }
}

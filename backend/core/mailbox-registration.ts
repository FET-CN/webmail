import type {
  MailboxRecord,
  RegistrationRequest,
  WebmailUser,
} from "./domain.ts";
import { AppError } from "./errors.ts";
import { createManagedMailbox } from "./mailbox-access.ts";
import { audit } from "./mailbox-lifecycle.ts";
import { generatedLocalPart } from "./migadu.ts";
import type { RuntimeAdapter } from "./runtime.ts";

const REGISTRATION_TTL_MS = 72 * 60 * 60 * 1000;

function internalAddressFor(
  localPart: string,
  runtime: RuntimeAdapter,
): string {
  return `${localPart}@${runtime.config.internalMailDomain}`;
}

export function requestMailboxRegistration(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  input: { local_part: string; name?: string },
): Promise<RegistrationRequest> {
  const raw = String(input.local_part || "").trim();
  if (!raw || raw.includes("@")) {
    throw new AppError(
      "INVALID_PARAMS",
      "A local_part is required.",
      "local_part",
    );
  }
  const localPart = generatedLocalPart(raw);
  const domain = runtime.config.mailDomain;
  const key = "mailbox:" + domain.toLowerCase() + ":" +
    localPart.toLowerCase();
  return runtime.provisioning.run(key, () =>
    requestMailboxRegistrationLocked(runtime, user, {
      localPart,
      domain,
      address: `${localPart}@${domain}`,
      name: input.name,
    })
  );
}

async function requestMailboxRegistrationLocked(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  input: {
    localPart: string;
    domain: string;
    address: string;
    name?: string;
  },
): Promise<RegistrationRequest> {
  const now = new Date().toISOString();
  if (
    input.domain.toLowerCase() ===
      runtime.config.internalMailDomain.toLowerCase()
  ) {
    throw new AppError(
      "INVALID_PARAMS",
      "The public mailbox domain cannot be the internal mail domain.",
      "local_part",
    );
  }
  if (await runtime.directory.getMailboxByAddress(input.address)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The mailbox address is already assigned.",
      "local_part",
    );
  }
  if (await runtime.directory.getMailboxByInternalAddress(input.address)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The mailbox address is already assigned internally.",
      "local_part",
    );
  }
  const internal = internalAddressFor(input.localPart, runtime);
  if (await runtime.directory.getMailboxByInternalAddress(internal)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The internal mailbox address is already assigned.",
      "local_part",
    );
  }
  if (await runtime.directory.getMailboxByAddress(internal)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The internal mailbox address conflicts with a public mailbox.",
      "local_part",
    );
  }
  const remote = await runtime.migaduAdmin.getMailbox(
    input.localPart,
    input.domain,
  );
  if (remote) {
    throw new AppError(
      "ADDRESS_UNAVAILABLE",
      "The mailbox already exists at the provider. Claim it instead.",
      "local_part",
    );
  }
  const pendingRegistrations = await runtime.directory
    .listPendingRegistrationRequests();
  if (
    pendingRegistrations.some((request) =>
      request.address.toLowerCase() === input.address.toLowerCase()
    )
  ) {
    throw new AppError(
      "REGISTRATION_DUPLICATE",
      "This address already has a pending registration.",
    );
  }
  const pendingClaims = await runtime.directory
    .listPendingMailboxClaimRequests();
  if (
    pendingClaims.some((claim) =>
      claim.address.toLowerCase() === input.address.toLowerCase()
    )
  ) {
    throw new AppError(
      "ADDRESS_PENDING_CLAIM",
      "This address already has a pending claim.",
    );
  }
  const request: RegistrationRequest = {
    id: crypto.randomUUID(),
    userId: user.id,
    localPart: input.localPart,
    domain: input.domain,
    address: input.address,
    name: input.name,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await runtime.directory.putRegistrationRequest(request);
  await audit(runtime, user.id, "mailbox.registration.requested", {
    address: input.address,
  });
  return request;
}

export async function approveRegistration(
  runtime: RuntimeAdapter,
  admin: WebmailUser,
  requestId: string,
  note?: string,
): Promise<{ request: RegistrationRequest; mailbox: MailboxRecord }> {
  const request = await runtime.directory.getRegistrationRequest(requestId);
  if (!request || request.state !== "pending") {
    throw new AppError(
      "INVALID_PARAMS",
      "The registration request is not pending.",
    );
  }
  // Serialize approvals of the same request; address-level exclusivity is
  // enforced by createManagedMailbox's own lock inside the locked block.
  return runtime.provisioning.run("registration:" + requestId, () =>
    approveRegistrationLocked(runtime, admin, request, note)
  );
}

async function approveRegistrationLocked(
  runtime: RuntimeAdapter,
  admin: WebmailUser,
  request: RegistrationRequest,
  note?: string,
): Promise<{ request: RegistrationRequest; mailbox: MailboxRecord }> {
  const now = new Date().toISOString();
  const current = await runtime.directory.getRegistrationRequest(request.id);
  if (!current || current.state !== "pending") {
    if (current?.state === "approved" && current.mailboxId) {
      const mailbox = await runtime.directory.getMailbox(current.mailboxId);
      if (mailbox) return { request: current, mailbox };
    }
    throw new AppError(
      "INVALID_PARAMS",
      "The registration request is not pending.",
    );
  }
  const owner = await runtime.directory.getUser(current.userId);
  if (!owner || !owner.enabled) {
    current.state = "rejected";
    current.reviewNote = "The requesting identity is unavailable.";
    current.reviewedBy = admin.id;
    current.reviewedAt = now;
    current.updatedAt = now;
    await runtime.directory.putRegistrationRequest(current);
    throw new AppError(
      "INVALID_PARAMS",
      "The requesting identity is unavailable.",
    );
  }
  if (await runtime.directory.getMailboxByAddress(current.address)) {
    current.state = "rejected";
    current.reviewNote = "The address was claimed before approval.";
    current.reviewedBy = admin.id;
    current.reviewedAt = now;
    current.updatedAt = now;
    await runtime.directory.putRegistrationRequest(current);
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The address is no longer available.",
    );
  }
  if (
    await runtime.migaduAdmin.getMailbox(current.localPart, current.domain)
  ) {
    current.state = "rejected";
    current.reviewNote = "The mailbox already exists at the provider.";
    current.reviewedBy = admin.id;
    current.reviewedAt = now;
    current.updatedAt = now;
    await runtime.directory.putRegistrationRequest(current);
    throw new AppError(
      "ADDRESS_UNAVAILABLE",
      "The mailbox already exists at the provider.",
    );
  }
  const created = await createManagedMailbox(runtime, {
    localPart: current.localPart,
    domain: current.domain,
    name: current.name || current.localPart,
    ownerUserId: current.userId,
    createdBy: admin.id,
  });
  current.state = "approved";
  current.mailboxId = created.mailbox.id;
  current.reviewNote = note;
  current.reviewedBy = admin.id;
  current.reviewedAt = now;
  current.updatedAt = now;
  await runtime.directory.putRegistrationRequest(current);
  await audit(
    runtime,
    admin.id,
    "mailbox.registration.approved",
    { address: current.address },
    created.mailbox.id,
    current.userId,
  );
  return { request: current, mailbox: created.mailbox };
}

export async function rejectRegistration(
  runtime: RuntimeAdapter,
  admin: WebmailUser,
  requestId: string,
  note?: string,
): Promise<RegistrationRequest> {
  const request = await runtime.directory.getRegistrationRequest(requestId);
  if (!request || request.state !== "pending") {
    throw new AppError(
      "INVALID_PARAMS",
      "The registration request is not pending.",
    );
  }
  request.state = "rejected";
  request.reviewNote = note;
  request.reviewedBy = admin.id;
  request.reviewedAt = new Date().toISOString();
  request.updatedAt = new Date().toISOString();
  await runtime.directory.putRegistrationRequest(request);
  await audit(
    runtime,
    admin.id,
    "mailbox.registration.rejected",
    { address: request.address },
    undefined,
    request.userId,
  );
  return request;
}

export function listMyRegistrations(
  runtime: RuntimeAdapter,
  userId: string,
): Promise<RegistrationRequest[]> {
  return runtime.directory.listRegistrationRequestsForUser(userId);
}

export function listPendingRegistrations(
  runtime: RuntimeAdapter,
): Promise<RegistrationRequest[]> {
  return runtime.directory.listPendingRegistrationRequests();
}

/** Rejects pending registrations that were never reviewed within the TTL. */
export async function reconcileRegistrationRequests(
  runtime: RuntimeAdapter,
  actorUserId = "system:lifecycle",
  now = Date.now(),
): Promise<void> {
  for (
    const request of await runtime.directory.listPendingRegistrationRequests()
  ) {
    if (Date.parse(request.createdAt) + REGISTRATION_TTL_MS <= now) {
      request.state = "rejected";
      request.reviewNote = "Expired without review.";
      request.reviewedBy = actorUserId;
      request.reviewedAt = new Date(now).toISOString();
      request.updatedAt = new Date(now).toISOString();
      await runtime.directory.putRegistrationRequest(request);
      await audit(runtime, actorUserId, "mailbox.registration.expired", {
        address: request.address,
      });
    }
  }
}

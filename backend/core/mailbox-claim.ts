import type {
  MailboxClaimRequest,
  MailboxCredential,
  MailboxRecord,
  WebmailUser,
} from "./domain.ts";
import { AppError } from "./errors.ts";
import { audit } from "./mailbox-lifecycle.ts";
import { attachClaimedMailbox } from "./mailbox-access.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { sendVerificationMail } from "./verification-mail.ts";

const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function generateVerificationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

async function hmacCode(code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mailbox-claim:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(code),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validClaimAddress(address: string): void {
  if (!/^[^@\s<>\r\n]+@[^@\s<>\r\n]+$/.test(address)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The email address is invalid.",
      "address",
    );
  }
}

function addressParts(
  address: string,
): { localPart: string; domain: string } {
  const at = address.lastIndexOf("@");
  return {
    localPart: address.slice(0, at).toLowerCase(),
    domain: address.slice(at + 1).toLowerCase(),
  };
}

export function requestMailboxClaim(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  sender: { mailbox: MailboxRecord; credential: MailboxCredential },
  input: { address: string },
): Promise<MailboxClaimRequest> {
  validClaimAddress(input.address);
  const { localPart, domain } = addressParts(input.address);
  const key = "mailbox:" + domain + ":" + localPart;
  return runtime.provisioning.run(key, () =>
    requestMailboxClaimLocked(runtime, user, sender, {
      address: `${localPart}@${domain}`,
      localPart,
      domain,
    })
  );
}

async function requestMailboxClaimLocked(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  sender: { mailbox: MailboxRecord; credential: MailboxCredential },
  input: { address: string; localPart: string; domain: string },
): Promise<MailboxClaimRequest> {
  const now = new Date().toISOString();
  if (input.domain !== runtime.config.mailDomain.toLowerCase()) {
    throw new AppError(
      "INVALID_PARAMS",
      "Only the primary mail domain can be claimed.",
      "address",
    );
  }
  const existing = await runtime.directory.getMailboxByAddress(input.address);
  if (existing) {
    if (existing.ownerUserId === user.id) {
      throw new AppError(
        "ADDRESS_ALREADY_BOUND",
        "This address is already your mailbox.",
      );
    }
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The mailbox address is already assigned.",
    );
  }
  if (await runtime.directory.getMailboxByInternalAddress(input.address)) {
    throw new AppError(
      "ADDRESS_ALREADY_BOUND",
      "The mailbox address is already assigned internally.",
    );
  }
  const internal = `${input.localPart}@${runtime.config.internalMailDomain}`;
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
  const pendingClaims = await runtime.directory.listPendingMailboxClaimRequests();
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
  const pendingRegistrations = await runtime.directory
    .listPendingRegistrationRequests();
  if (
    pendingRegistrations.some((request) =>
      request.address.toLowerCase() === input.address.toLowerCase()
    )
  ) {
    throw new AppError(
      "ADDRESS_PENDING_CLAIM",
      "This address already has a pending registration.",
    );
  }
  const code = generateVerificationCode();
  const tokenHash = await hmacCode(
    code,
    runtime.config.credentialEncryptionKey,
  );
  const claim: MailboxClaimRequest = {
    id: crypto.randomUUID(),
    userId: user.id,
    localPart: input.localPart,
    domain: input.domain,
    address: input.address,
    state: "pending_verification",
    tokenHash,
    tokenExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS).toISOString(),
    attempts: 0,
    verificationMailSentAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await runtime.directory.putMailboxClaimRequest(claim);
  try {
    await sendVerificationMail(runtime, {
      to: input.address,
      from: sender.mailbox.address,
      credential: sender.credential,
      code,
    });
  } catch (error) {
    await runtime.directory.deleteMailboxClaimRequest(claim.id);
    throw error;
  }
  await audit(runtime, user.id, "mailbox.claim.requested", {
    address: input.address,
  });
  return claim;
}

export function submitMailboxClaimCode(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  claimId: string,
  code: string,
): Promise<{ claim: MailboxClaimRequest; mailbox?: MailboxRecord }> {
  return runtime.provisioning.run("claim:" + claimId, () =>
    submitMailboxClaimCodeLocked(runtime, user, claimId, code)
  );
}

async function submitMailboxClaimCodeLocked(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  claimId: string,
  code: string,
): Promise<{ claim: MailboxClaimRequest; mailbox?: MailboxRecord }> {
  const now = Date.now();
  const claim = await runtime.directory.getMailboxClaimRequest(claimId);
  if (!claim || claim.userId !== user.id) {
    throw new AppError("FORBIDDEN", "The claim request is not available.");
  }
  if (claim.state !== "pending_verification") {
    throw new AppError(
      "VERIFICATION_EXPIRED",
      "The verification code has already been used.",
    );
  }
  if (Date.parse(claim.tokenExpiresAt) <= now) {
    claim.state = "expired";
    claim.updatedAt = new Date(now).toISOString();
    await runtime.directory.putMailboxClaimRequest(claim);
    await audit(runtime, user.id, "mailbox.claim.expired", {
      address: claim.address,
    });
    throw new AppError(
      "VERIFICATION_EXPIRED",
      "The verification code has expired.",
    );
  }
  if (claim.attempts >= MAX_ATTEMPTS) {
    claim.state = "expired";
    claim.updatedAt = new Date(now).toISOString();
    await runtime.directory.putMailboxClaimRequest(claim);
    throw new AppError(
      "VERIFICATION_EXPIRED",
      "Too many failed attempts. Request a new code.",
    );
  }
  const expectedHash = await hmacCode(
    code,
    runtime.config.credentialEncryptionKey,
  );
  if (expectedHash !== claim.tokenHash) {
    claim.attempts += 1;
    const exhausted = claim.attempts >= MAX_ATTEMPTS;
    if (exhausted) claim.state = "expired";
    claim.updatedAt = new Date(now).toISOString();
    await runtime.directory.putMailboxClaimRequest(claim);
    if (exhausted) {
      throw new AppError(
        "VERIFICATION_EXPIRED",
        "Too many failed attempts. Request a new code.",
      );
    }
    throw new AppError(
      "VERIFICATION_FAILED",
      `The verification code is incorrect. ${
        MAX_ATTEMPTS - claim.attempts
      } attempts remaining.`,
    );
  }
  claim.state = "verified";
  claim.claimedAt = new Date(now).toISOString();
  claim.updatedAt = new Date(now).toISOString();
  await runtime.directory.putMailboxClaimRequest(claim);
  await audit(runtime, user.id, "mailbox.claim.verified", {
    address: claim.address,
  });
  const attached = await attachClaimedMailbox(runtime, {
    address: claim.address,
    ownerUserId: user.id,
    createdBy: user.id,
  });
  claim.mailboxId = attached.mailbox.id;
  claim.updatedAt = new Date().toISOString();
  await runtime.directory.putMailboxClaimRequest(claim);
  return { claim, mailbox: attached.mailbox };
}

export function completeMailboxClaim(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  claimId: string,
): Promise<{ claim: MailboxClaimRequest; mailbox: MailboxRecord }> {
  return runtime.provisioning.run("claim:" + claimId, () =>
    completeMailboxClaimLocked(runtime, user, claimId)
  );
}

async function completeMailboxClaimLocked(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  claimId: string,
): Promise<{ claim: MailboxClaimRequest; mailbox: MailboxRecord }> {
  const claim = await runtime.directory.getMailboxClaimRequest(claimId);
  if (!claim || claim.userId !== user.id) {
    throw new AppError("FORBIDDEN", "The claim request is not available.");
  }
  if (claim.state !== "verified") {
    throw new AppError(
      "VERIFICATION_EXPIRED",
      "The claim is not awaiting completion.",
    );
  }
  if (claim.mailboxId) {
    const mailbox = await runtime.directory.getMailbox(claim.mailboxId);
    if (mailbox) return { claim, mailbox };
  }
  const attached = await attachClaimedMailbox(runtime, {
    address: claim.address,
    ownerUserId: user.id,
    createdBy: user.id,
  });
  claim.mailboxId = attached.mailbox.id;
  claim.updatedAt = new Date().toISOString();
  await runtime.directory.putMailboxClaimRequest(claim);
  return { claim, mailbox: attached.mailbox };
}

export function listMyClaims(
  runtime: RuntimeAdapter,
  userId: string,
): Promise<MailboxClaimRequest[]> {
  return runtime.directory.listMailboxClaimRequestsForUser(userId);
}

/** Expires stale pending claims; safe to run repeatedly on a schedule. */
export async function reconcileClaimRequests(
  runtime: RuntimeAdapter,
  actorUserId = "system:lifecycle",
  now = Date.now(),
): Promise<void> {
  for (
    const claim of await runtime.directory.listPendingMailboxClaimRequests()
  ) {
    if (Date.parse(claim.tokenExpiresAt) <= now) {
      claim.state = "expired";
      claim.updatedAt = new Date(now).toISOString();
      await runtime.directory.putMailboxClaimRequest(claim);
      await audit(runtime, actorUserId, "mailbox.claim.expired", {
        address: claim.address,
      });
    }
  }
}

export type MailboxState =
  | "provisioning"
  | "active"
  | "suspended"
  | "pending_delete"
  | "deleted";
export type MailboxGrantRole = "owner" | "member" | "manager";

export interface WebmailUser {
  id: string;
  issuer: string;
  subject: string;
  preferredUsername: string;
  email?: string;
  groups: string[];
  primaryMailboxId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxRecord {
  id: string;
  address: string;
  internalAddress?: string;
  localPart: string;
  domain: string;
  state: MailboxState;
  ownerUserId: string;
  localDeliveryEnabled: boolean;
  migaduLocalPart?: string;
  credentialId?: string;
  retiredCredentialIds?: string[];
  deletionIdentityRemoved?: boolean;
  deletionMailboxRemoved?: boolean;
  deleteAfter?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxGrant {
  userId: string;
  mailboxId: string;
  role: MailboxGrantRole;
  createdAt: string;
  createdBy: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string;
  action: string;
  mailboxId?: string;
  targetUserId?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface MailboxCredential {
  id: string;
  mailboxId: string;
  username: string;
  password: string;
  keyVersion: number;
  createdAt: string;
}

export type RegistrationRequestState = "pending" | "approved" | "rejected";

export interface RegistrationRequest {
  id: string;
  userId: string;
  localPart: string;
  domain: string;
  address: string;
  name?: string;
  state: RegistrationRequestState;
  mailboxId?: string;
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ClaimRequestState = "pending_verification" | "verified" | "expired";

export interface MailboxClaimRequest {
  id: string;
  userId: string;
  localPart: string;
  domain: string;
  address: string;
  state: ClaimRequestState;
  tokenHash: string;
  tokenExpiresAt: string;
  attempts: number;
  verificationMailSentAt: string;
  mailboxId?: string;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

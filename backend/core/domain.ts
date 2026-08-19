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

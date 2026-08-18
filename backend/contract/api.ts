export type JsonObject = Record<string, unknown>;

export interface RpcError {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  object: "error";
  code: string;
  request_id: string;
  retryable: boolean;
  param?: string;
}

export interface ResourceList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
  page: number;
  page_size: number;
}

export interface MailboxSummary {
  object: "mailbox";
  id: string;
  name: string;
  flags: string[];
  delimiter: string;
  exists?: number;
  unseen?: number;
}

export interface MessageSummary {
  object: "message_summary";
  id: string;
  mailbox: string;
  uid: number;
  subject?: string;
  from?: string[];
  to?: string[];
  date?: string;
  flags: string[];
  size?: number;
}

export interface MessageResource extends Omit<MessageSummary, "object" | "mailbox"> {
  object: "message";
  mailbox: string | MailboxSummary;
  raw?: string;
  headers?: JsonObject;
  attachments?: Array<{ filename?: string; content_type?: string; size?: number }>;
}

export interface Event<T = JsonObject> {
  object: "event";
  id: string;
  type: string;
  created_at: string;
  data: T;
}

export interface CursorPayload {
  version: 1;
  mailbox: string;
  date: string;
  uid: number;
  page: number;
}

export interface ExpandOptions {
  expand?: string[];
}

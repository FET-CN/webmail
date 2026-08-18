export const PROBLEM_DEFINITIONS = {
  AUTH_REQUIRED: {
    slug: "auth-required",
    title: "Authentication required",
    status: 401,
    retryable: false,
  },
  AUTH_INVALID: {
    slug: "auth-invalid",
    title: "Authentication failed",
    status: 401,
    retryable: false,
  },
  SESSION_EXPIRED: {
    slug: "session-expired",
    title: "Session expired",
    status: 401,
    retryable: false,
  },
  MAILBOX_NOT_FOUND: {
    slug: "mailbox-not-found",
    title: "Mailbox not found",
    status: 404,
    retryable: false,
  },
  MESSAGE_NOT_FOUND: {
    slug: "message-not-found",
    title: "Message not found",
    status: 404,
    retryable: false,
  },
  UPSTREAM_AUTH_FAILED: {
    slug: "upstream-auth-failed",
    title: "Upstream authentication failed",
    status: 502,
    retryable: false,
  },
  UPSTREAM_UNAVAILABLE: {
    slug: "upstream-unavailable",
    title: "Mail provider unavailable",
    status: 503,
    retryable: true,
  },
  MESSAGE_TOO_LARGE: {
    slug: "message-too-large",
    title: "Message too large",
    status: 413,
    retryable: false,
  },
  TOO_MANY_RECIPIENTS: {
    slug: "too-many-recipients",
    title: "Too many recipients",
    status: 400,
    retryable: false,
  },
  RATE_LIMITED: {
    slug: "rate-limited",
    title: "Too many requests",
    status: 429,
    retryable: true,
  },
  INVALID_PARAMS: {
    slug: "invalid-params",
    title: "Invalid parameters",
    status: 400,
    retryable: false,
  },
  INVALID_CURSOR: {
    slug: "invalid-cursor",
    title: "Invalid pagination cursor",
    status: 409,
    retryable: false,
  },
  SYNC_REQUIRED: {
    slug: "sync-required",
    title: "Synchronization required",
    status: 409,
    retryable: true,
  },
  PROBLEM_TYPE_NOT_FOUND: {
    slug: "problem-type-not-found",
    title: "Problem type not found",
    status: 404,
    retryable: false,
  },
} as const;

export type ProblemCode = keyof typeof PROBLEM_DEFINITIONS;

export interface BackendConfig {
  jwtSecret: string;
  credentialEncryptionKey: string;
  problemTypeBaseUrl: string;
  appOrigin: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  oidcWebmailGroup: string;
  oidcAdminGroup: string;
  oidcReauthSeconds: number;
  mailDomain: string;
  internalMailDomain: string;
  mailboxProvisioningEnabled: boolean;
  migaduApiBaseUrl: string;
  migaduApiUser: string;
  migaduApiKey: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  sessionTtlSeconds: number;
  lifecycleIntervalSeconds: number;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  maxMessageBytes: number;
  maxRecipients: number;
}

function required(
  values: Record<string, string | undefined>,
  key: string,
): string {
  const value = values[key];
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

export function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}

function numberValue(
  values: Record<string, string | undefined>,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const value = Number(values[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid configuration: ${key}`);
  }
  return value;
}

export function configFromEnv(
  env: Record<string, string | undefined>,
): BackendConfig {
  const jwtSecret = required(env, "JWT_SECRET");
  const mailDomain = env.MAIL_DOMAIN || "";
  const internalMailDomain = env.INTERNAL_MAIL_DOMAIN ||
    (mailDomain ? `internal.${mailDomain}` : "");
  if (
    mailDomain && internalMailDomain &&
    mailDomain.toLowerCase() === internalMailDomain.toLowerCase()
  ) {
    throw new Error("INTERNAL_MAIL_DOMAIN must differ from MAIL_DOMAIN");
  }
  return {
    jwtSecret,
    credentialEncryptionKey: required(env, "CREDENTIAL_ENCRYPTION_KEY"),
    problemTypeBaseUrl: env.PROBLEM_TYPE_BASE_URL ||
      "http://localhost:8787/problems",
    appOrigin: required(env, "APP_ORIGIN"),
    oidcIssuer: env.OIDC_ISSUER || "",
    oidcClientId: env.OIDC_CLIENT_ID || "",
    oidcClientSecret: env.OIDC_CLIENT_SECRET || "",
    oidcRedirectUri: env.OIDC_REDIRECT_URI || "",
    oidcWebmailGroup: env.OIDC_WEBMAIL_GROUP || "webmail-users",
    oidcAdminGroup: env.OIDC_ADMIN_GROUP || "webmail-admin",
    oidcReauthSeconds: numberValue(env, "OIDC_REAUTH_SECONDS", 900, 60),
    mailDomain,
    internalMailDomain,
    mailboxProvisioningEnabled: env.MAILBOX_PROVISIONING_ENABLED !== "false",
    migaduApiBaseUrl: env.MIGADU_API_BASE_URL || "https://api.migadu.com/v1",
    migaduApiUser: env.MIGADU_API_USER || "",
    migaduApiKey: env.MIGADU_API_KEY || "",
    accessTtlSeconds: numberValue(env, "JWT_ACCESS_TTL_SECONDS", 900, 1),
    refreshTtlSeconds: numberValue(
      env,
      "JWT_REFRESH_TTL_SECONDS",
      2_592_000,
      1,
    ),
    sessionTtlSeconds: numberValue(env, "SESSION_TTL_SECONDS", 2_592_000, 1),
    lifecycleIntervalSeconds: numberValue(
      env,
      "LIFECYCLE_RECONCILE_SECONDS",
      300,
      30,
    ),
    imapHost: env.MIGADU_IMAP_HOST || "imap.migadu.com",
    imapPort: numberValue(env, "MIGADU_IMAP_PORT", 993, 1),
    smtpHost: env.MIGADU_SMTP_HOST || "smtp.migadu.com",
    smtpPort: numberValue(env, "MIGADU_SMTP_PORT", 465, 1),
    maxMessageBytes: numberValue(env, "MAX_MESSAGE_BYTES", 10 * 1024 * 1024, 1),
    maxRecipients: numberValue(env, "MAX_RECIPIENTS", 25, 1),
  };
}

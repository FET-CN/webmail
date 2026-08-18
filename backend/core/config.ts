export interface BackendConfig {
  jwtSecret: string;
  problemTypeBaseUrl: string;
  appOrigin: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  sessionTtlSeconds: number;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  maxMessageBytes: number;
  maxRecipients: number;
}

function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

function numberValue(values: Record<string, string | undefined>, key: string, fallback: number, minimum: number): number {
  const value = Number(values[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid configuration: ${key}`);
  return value;
}

export function configFromEnv(env: Record<string, string | undefined>): BackendConfig {
  return {
    jwtSecret: required(env, "JWT_SECRET"),
    problemTypeBaseUrl: env.PROBLEM_TYPE_BASE_URL || "http://localhost:8787/problems",
    appOrigin: required(env, "APP_ORIGIN"),
    accessTtlSeconds: numberValue(env, "JWT_ACCESS_TTL_SECONDS", 900, 1),
    refreshTtlSeconds: numberValue(env, "JWT_REFRESH_TTL_SECONDS", 2_592_000, 1),
    sessionTtlSeconds: numberValue(env, "SESSION_TTL_SECONDS", 2_592_000, 1),
    imapHost: env.MIGADU_IMAP_HOST || "imap.migadu.com",
    imapPort: numberValue(env, "MIGADU_IMAP_PORT", 993, 1),
    smtpHost: env.MIGADU_SMTP_HOST || "smtp.migadu.com",
    smtpPort: numberValue(env, "MIGADU_SMTP_PORT", 465, 1),
    maxMessageBytes: numberValue(env, "MAX_MESSAGE_BYTES", 10 * 1024 * 1024, 1),
    maxRecipients: numberValue(env, "MAX_RECIPIENTS", 25, 1),
  };
}

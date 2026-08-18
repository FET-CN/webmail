import type { BackendConfig } from "./config.ts";
import { signToken, verifyToken, type TokenClaims } from "./jwt.ts";
import { AppError } from "./errors.ts";

export interface MailCredentials {
  username: string;
  password: string;
}

export interface SessionRecord {
  sid: string;
  credentials: MailCredentials;
  refreshJti: string;
  refreshFamily: string;
  expiresAt: number;
  idempotency?: Record<string, { status: number; body: unknown; expiresAt: number }>;
}

export interface SessionStore {
  get(sid: string): Promise<SessionRecord | null>;
  put(record: SessionRecord): Promise<void>;
  delete(sid: string): Promise<void>;
  revokeFamily(family: string): Promise<void>;
  isFamilyRevoked(family: string): Promise<boolean>;
}

export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly revokedFamilies = new Set<string>();

  async get(sid: string): Promise<SessionRecord | null> {
    const record = this.records.get(sid);
    if (!record || record.expiresAt <= Date.now()) {
      this.records.delete(sid);
      return null;
    }
    return record;
  }

  async put(record: SessionRecord): Promise<void> {
    this.records.set(record.sid, record);
  }

  async delete(sid: string): Promise<void> {
    this.records.delete(sid);
  }

  async revokeFamily(family: string): Promise<void> {
    this.revokedFamilies.add(family);
  }

  async isFamilyRevoked(family: string): Promise<boolean> {
    return this.revokedFamilies.has(family);
  }
}

export class SessionService {
  private readonly refreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken: string }>>();

  constructor(private readonly store: SessionStore, private readonly config: BackendConfig) {}

  async create(credentials: MailCredentials): Promise<{ accessToken: string; refreshToken: string; record: SessionRecord }> {
    const sid = crypto.randomUUID();
    const refreshFamily = crypto.randomUUID();
    const record: SessionRecord = {
      sid,
      credentials,
      refreshJti: "",
      refreshFamily,
      expiresAt: Date.now() + this.config.sessionTtlSeconds * 1000,
      idempotency: {},
    };
    const accessToken = await signToken(credentials.username, sid, "access", this.config.accessTtlSeconds, this.config.jwtSecret);
    const refreshToken = await signToken(credentials.username, sid, "refresh", this.config.refreshTtlSeconds, this.config.jwtSecret);
    record.refreshJti = (await verifyToken(refreshToken, "refresh", this.config.jwtSecret)).jti;
    await this.store.put(record);
    return { accessToken, refreshToken, record };
  }

  async access(token: string): Promise<{ claims: TokenClaims; record: SessionRecord }> {
    const claims = await verifyToken(token, "access", this.config.jwtSecret);
    const record = await this.store.get(claims.sid);
    if (!record || record.credentials.username !== claims.sub) {
      throw new AppError("SESSION_EXPIRED", "The authentication session has expired.");
    }
    return { claims, record };
  }

  async refresh(token: string): Promise<{ accessToken: string; refreshToken: string }> {
    let claimsHint: TokenClaims | null = null;
    try {
      claimsHint = await verifyToken(token, "refresh", this.config.jwtSecret);
    } catch (error) {
      throw error;
    }
    const previous = this.refreshLocks.get(claimsHint.sid) || Promise.resolve({ accessToken: "", refreshToken: "" });
    const current = previous.then(() => this.rotateRefresh(token));
    this.refreshLocks.set(claimsHint.sid, current);
    try {
      return await current;
    } finally {
      if (this.refreshLocks.get(claimsHint.sid) === current) this.refreshLocks.delete(claimsHint.sid);
    }
  }

  private async rotateRefresh(token: string): Promise<{ accessToken: string; refreshToken: string }> {
    const claims = await verifyToken(token, "refresh", this.config.jwtSecret);
    const record = await this.store.get(claims.sid);
    if (!record || record.refreshJti !== claims.jti || await this.store.isFamilyRevoked(record.refreshFamily)) {
      if (record) await this.store.revokeFamily(record.refreshFamily);
      throw new AppError("SESSION_EXPIRED", "The refresh session has expired.");
    }
    const accessToken = await signToken(claims.sub, claims.sid, "access", this.config.accessTtlSeconds, this.config.jwtSecret);
    const refreshToken = await signToken(claims.sub, claims.sid, "refresh", this.config.refreshTtlSeconds, this.config.jwtSecret);
    record.refreshJti = (await verifyToken(refreshToken, "refresh", this.config.jwtSecret)).jti;
    await this.store.put(record);
    return { accessToken, refreshToken };
  }

  async logout(sid: string): Promise<void> {
    await this.store.delete(sid);
  }
}

import { Injectable } from "@nestjs/common";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { QueryResultRow } from "pg";
import { PostgresService } from "../data/postgres.service";
import { RedisCacheService } from "../data/redis-cache.service";
import {
  AccountRecord,
  AuthenticatedAccount,
  AuthRequestPayload,
  AuthResult,
  ProfileUpdatePayload,
  PublicAccount,
} from "./auth.types";

const scrypt = promisify(scryptCallback);
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 72;
const MAX_DISPLAY_NAME_LENGTH = 16;
const INITIAL_POINTS = 1000;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

interface AccountRow extends QueryResultRow {
  id: string;
  username: string;
  display_name: string;
  points: number;
  password_salt: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

interface SessionRecord {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
}

@Injectable()
export class AuthService {
  private readonly sessionTtlSeconds = this.readPositiveInteger(
    process.env.SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS,
  );

  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: RedisCacheService,
  ) {}

  async register(payload: AuthRequestPayload): Promise<AuthResult> {
    const username = this.normalizeUsername(payload.username);
    const password = payload.password ?? "";
    const displayName = this.normalizeDisplayName(payload.displayName) || username;

    const validationError = this.validateRegistration(username, password);
    if (validationError) {
      return this.fail(validationError);
    }

    const now = new Date().toISOString();
    const salt = randomBytes(16).toString("hex");
    const account: AccountRecord = {
      id: randomUUID(),
      username,
      displayName,
      points: INITIAL_POINTS,
      passwordSalt: salt,
      passwordHash: await this.hashPassword(password, salt),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.postgres.query(
        `
          INSERT INTO accounts (
            id,
            username,
            display_name,
            points,
            password_salt,
            password_hash,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          account.id,
          account.username,
          account.displayName,
          account.points,
          account.passwordSalt,
          account.passwordHash,
          account.createdAt,
          account.updatedAt,
        ],
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return this.fail("账号已存在");
      }

      throw error;
    }

    return this.issueSession(account);
  }

  async login(payload: AuthRequestPayload): Promise<AuthResult> {
    const username = this.normalizeUsername(payload.username);
    const password = payload.password ?? "";
    const account = await this.findAccountByUsername(username);

    if (!account || !(await this.verifyPassword(password, account))) {
      return this.fail("账号或密码错误");
    }

    return this.issueSession(account);
  }

  async getAccountByToken(
    token: string | undefined,
  ): Promise<AuthenticatedAccount | null> {
    const normalizedToken = this.normalizeToken(token);
    if (!normalizedToken) {
      return null;
    }

    const session = await this.getSession(normalizedToken);
    if (!session) {
      return null;
    }

    const account = await this.findAccountById(session.userId);
    if (!account) {
      await this.deleteSession(normalizedToken);
      return null;
    }

    session.lastSeenAt = new Date().toISOString();
    await this.saveSession(normalizedToken, session);
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
    };
  }

  async getPublicAccountByToken(
    token: string | undefined,
  ): Promise<PublicAccount | null> {
    const account = await this.getAccountByToken(token);
    if (!account) {
      return null;
    }

    const record = await this.findAccountById(account.id);
    return record ? this.toPublicAccount(record) : null;
  }

  async updateProfile(
    token: string | undefined,
    payload: ProfileUpdatePayload,
  ): Promise<AuthResult> {
    const normalizedToken = this.normalizeToken(token);
    if (!normalizedToken) {
      return this.fail("未登录或登录已过期");
    }

    const session = await this.getSession(normalizedToken);
    if (!session) {
      return this.fail("未登录或登录已过期");
    }

    const account = await this.findAccountById(session.userId);
    if (!account) {
      await this.deleteSession(normalizedToken);
      return this.fail("未登录或登录已过期");
    }

    account.displayName =
      this.normalizeDisplayName(payload.displayName) || account.username;
    account.updatedAt = new Date().toISOString();
    session.lastSeenAt = account.updatedAt;

    await this.postgres.query(
      `
        UPDATE accounts
        SET display_name = $1, updated_at = $2
        WHERE id = $3
      `,
      [account.displayName, account.updatedAt, account.id],
    );
    await this.saveSession(normalizedToken, session);

    return {
      ok: true,
      user: this.toPublicAccount(account),
    };
  }

  async addPointsToAccounts(awards: Array<{ accountId: string; points: number }>) {
    const updatedAccounts: PublicAccount[] = [];

    for (const award of awards) {
      const points = Math.max(0, Math.floor(award.points));
      if (points <= 0) {
        continue;
      }

      const now = new Date().toISOString();
      const result = await this.postgres.query<AccountRow>(
        `
          UPDATE accounts
          SET points = points + $1, updated_at = $2
          WHERE id = $3
          RETURNING *
        `,
        [points, now, award.accountId],
      );
      const row = result.rows[0];
      if (!row) {
        continue;
      }

      updatedAccounts.push(this.toPublicAccount(this.fromRow(row)));
    }

    return updatedAccounts;
  }

  async logout(token: string | undefined) {
    const normalizedToken = this.normalizeToken(token);
    if (normalizedToken) {
      await this.deleteSession(normalizedToken);
    }

    return { ok: true };
  }

  private validateRegistration(username: string, password: string): string | null {
    if (!USERNAME_PATTERN.test(username)) {
      return "账号只能包含 3-20 位字母、数字或下划线";
    }

    if (
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return "密码长度需为 6-72 位";
    }

    return null;
  }

  private async issueSession(account: AccountRecord): Promise<AuthResult> {
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    await this.saveSession(token, {
      userId: account.id,
      createdAt: now,
      lastSeenAt: now,
    });

    return {
      ok: true,
      token,
      user: this.toPublicAccount(account),
    };
  }

  private async hashPassword(password: string, salt: string) {
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    return derivedKey.toString("hex");
  }

  private async verifyPassword(password: string, account: AccountRecord) {
    const hashedPassword = Buffer.from(
      await this.hashPassword(password, account.passwordSalt),
      "hex",
    );
    const storedPassword = Buffer.from(account.passwordHash, "hex");

    return (
      hashedPassword.length === storedPassword.length &&
      timingSafeEqual(hashedPassword, storedPassword)
    );
  }

  private async findAccountByUsername(username: string) {
    const result = await this.postgres.query<AccountRow>(
      "SELECT * FROM accounts WHERE username = $1",
      [username],
    );

    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  private async findAccountById(accountId: string) {
    const result = await this.postgres.query<AccountRow>(
      "SELECT * FROM accounts WHERE id = $1",
      [accountId],
    );

    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  private async getSession(token: string) {
    return this.cache.getJson<SessionRecord>(this.sessionKey(token));
  }

  private async saveSession(token: string, session: SessionRecord) {
    await this.cache.setJson(
      this.sessionKey(token),
      session,
      this.sessionTtlSeconds,
    );
  }

  private async deleteSession(token: string) {
    await this.cache.del(this.sessionKey(token));
  }

  private sessionKey(token: string) {
    return `auth:session:${token}`;
  }

  private fromRow(row: AccountRow): AccountRecord {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      points: row.points,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toPublicAccount(account: AccountRecord): PublicAccount {
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      points: account.points,
      createdAt: account.createdAt,
    };
  }

  private normalizeUsername(username: string | undefined) {
    return (username ?? "").trim().toLowerCase();
  }

  private normalizeDisplayName(displayName: string | undefined) {
    return (displayName ?? "").trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  }

  private normalizeToken(token: string | undefined) {
    return (token ?? "").trim();
  }

  private isUniqueViolation(error: unknown) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    );
  }

  private readPositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return Math.floor(parsed);
  }

  private fail(error: string): AuthResult {
    return {
      ok: false,
      error,
    };
  }
}

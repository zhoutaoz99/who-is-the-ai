export interface AuthRequestPayload {
  username?: string;
  password?: string;
  displayName?: string;
}

export interface ProfileUpdatePayload {
  displayName?: string;
}

export interface AccountRecord {
  id: string;
  username: string;
  displayName: string;
  points: number;
  gamesPlayed: number;
  gamesWon: number;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAccount {
  id: string;
  username: string;
  displayName: string;
  points: number;
  gamesPlayed: number;
  gamesWon: number;
  createdAt: string;
}

export interface AuthenticatedAccount {
  id: string;
  username: string;
  displayName: string;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  token?: string;
  user?: PublicAccount;
}

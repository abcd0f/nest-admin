import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

const ARGON2ID_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

/** Password hashing for credentials stored by persistence services. */
@Injectable()
export class PasswordHashService {
  /** Returns a PHC-encoded Argon2id hash with its salt and parameters embedded. */
  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2ID_OPTIONS);
  }

  /** Verifies a password against the PHC-encoded hash stored in the database. */
  verifyPassword(encodedHash: string, password: string): Promise<boolean> {
    return argon2.verify(encodedHash, password);
  }
}

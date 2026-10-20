import { describe, expect, it } from 'vitest';

import { PasswordHashService } from './password-hash.service.js';

describe('passwordHashService', () => {
  const service = new PasswordHashService();

  it('stores a verifiable Argon2id PHC hash without storing the plaintext', async () => {
    const password = 'correct horse battery staple';
    const encodedHash = await service.hashPassword(password);

    expect(encodedHash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(encodedHash).not.toContain(password);
    await expect(service.verifyPassword(encodedHash, password)).resolves.toBe(true);
    await expect(service.verifyPassword(encodedHash, 'incorrect password')).resolves.toBe(false);
  });
});

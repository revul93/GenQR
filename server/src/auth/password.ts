import argon2 from 'argon2';

export const PASSWORD_MIN_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain both letters and digits.';
  return null;
}

let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real check, so response timing doesn't reveal which usernames exist. */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('genqr-timing-equaliser-1');
  await verifyPassword(await dummyHash, password);
}

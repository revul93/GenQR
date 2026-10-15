import { HttpError } from '../http.js';

/**
 * Verifies an imported AD user's password by binding to the directory.
 * Implemented in Phase 2 (AD configuration); until then AD users cannot sign in.
 */
export async function verifyAdCredentials(_username: string, _password: string): Promise<boolean> {
  throw new HttpError(503, 'Active Directory sign-in is not configured yet.', 'AD_NOT_CONFIGURED');
}

/** The service account that signs the requests Google Chat itself sends. */
export const CHAT_ISSUER = 'chat@system.gserviceaccount.com';

/** The service account the Workspace add-on of one Google Cloud project signs its requests with. */
export function addOnIssuer(projectNumber: string): string {
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}

/**
 * Whether the verified email of an app-url token belongs to Google Chat, or to the Workspace add-on of the one
 * Google Cloud project this installation names. An add-on of any other project is refused: the audience check
 * alone cannot tell this installation's add-on from another add-on pointed at the same URL.
 *
 * @param email - The `email` claim of a token whose signature and `email_verified` claim were already checked.
 * @param addOnProjectNumber - The numeric project number of the accepted add-on; unset or not numeric accepts none.
 */
export function isChatIssuer(email: string, addOnProjectNumber?: string): boolean {
  if (email === CHAT_ISSUER) return true;
  const projectNumber = (addOnProjectNumber ?? '').trim();
  return /^\d+$/.test(projectNumber) && email === addOnIssuer(projectNumber);
}

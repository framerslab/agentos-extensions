/** The service account that signs the requests Google Chat itself sends. */
export const CHAT_ISSUER = 'chat@system.gserviceaccount.com';

/** The service account a Google Workspace add-on signs its requests with: service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com. */
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;

/**
 * Whether the verified email of an app-url token belongs to Google Chat or to a Workspace add-on.
 *
 * @param email - The `email` claim of a token whose signature and `email_verified` claim were already checked.
 */
export function isChatIssuer(email: string): boolean {
  return email === CHAT_ISSUER || ADDON_ISSUER_PATTERN.test(email);
}

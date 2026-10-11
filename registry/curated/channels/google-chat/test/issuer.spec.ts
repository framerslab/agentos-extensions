import { describe, expect, it } from 'vitest';
import { CHAT_ISSUER, isChatIssuer } from '../src/issuer';

describe('isChatIssuer', () => {
  it('accepts the Google Chat service account', () => {
    expect(isChatIssuer(CHAT_ISSUER)).toBe(true);
  });

  // The pattern was once written with doubled backslashes and matched no address.
  it('accepts a Workspace add-on service account', () => {
    expect(isChatIssuer('service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com')).toBe(true);
  });

  it('rejects addresses that only resemble an add-on service account', () => {
    expect(isChatIssuer('service-abc@gcp-sa-gsuiteaddons.iam.gserviceaccount.com')).toBe(false);
    expect(isChatIssuer('service-123@gcp-sa-gsuiteaddonsXiamXgserviceaccountXcom')).toBe(false);
    expect(isChatIssuer('service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com.example.org')).toBe(false);
    expect(isChatIssuer('xservice-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com')).toBe(false);
  });

  it('rejects other addresses', () => {
    expect(isChatIssuer('someone@example.com')).toBe(false);
    expect(isChatIssuer('')).toBe(false);
  });
});

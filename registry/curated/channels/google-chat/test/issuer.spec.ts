import { describe, expect, it } from 'vitest';
import { addOnIssuer, CHAT_ISSUER, isChatIssuer } from '../src/issuer';

describe('isChatIssuer', () => {
  it('accepts the Google Chat service account, with or without an add-on project', () => {
    expect(isChatIssuer(CHAT_ISSUER)).toBe(true);
    expect(isChatIssuer(CHAT_ISSUER, '123456789012')).toBe(true);
  });

  it('accepts the add-on service account of the configured project', () => {
    expect(isChatIssuer('service-123456789012@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', '123456789012')).toBe(true);
    expect(isChatIssuer(addOnIssuer('42'), ' 42 ')).toBe(true);
  });

  // Any add-on can point at this URL and get a token for it; only the configured project is trusted.
  it('refuses the add-on service account of another project', () => {
    expect(isChatIssuer('service-999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', '123456789012')).toBe(false);
  });

  it('refuses every add-on when no project is configured or the value is not a number', () => {
    expect(isChatIssuer('service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com')).toBe(false);
    expect(isChatIssuer('service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', '')).toBe(false);
    expect(isChatIssuer('service-abc@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', 'abc')).toBe(false);
  });

  it('refuses addresses that only resemble the configured add-on', () => {
    expect(isChatIssuer('service-123@gcp-sa-gsuiteaddonsXiamXgserviceaccountXcom', '123')).toBe(false);
    expect(isChatIssuer('service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com.example.org', '123')).toBe(false);
    expect(isChatIssuer('xservice-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', '123')).toBe(false);
    expect(isChatIssuer('someone@example.com', '123')).toBe(false);
    expect(isChatIssuer('', '123')).toBe(false);
  });
});

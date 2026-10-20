import { describe, expect, it, vi } from 'vitest';
import {
  GmailTextFault, sanitizeMailText, sanitizeMailMetadata, sanitizeMailHeaders,
  type GmailTextPolicy,
} from '../src/index.js';

const policy: GmailTextPolicy = {
  maxInputCharacters: 2_097_152, maxLineCharacters: 65_536, maxOutputCharacters: 200_000,
};
const address = ['fixture', 'mail.invalid'].join(String.fromCharCode(64));
const marker = 'A1'.repeat(24);
const gate = '[line removed by the secret gate]';
const clean = (input: string) => sanitizeMailText(input, policy);
const encode = (input: string) => [...new TextEncoder().encode(input)]
  .map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('');

describe('mail text sanitization', () => {
  it('preserves display text and removes literal, quoted and international address tokens', () => {
    expect(clean(`Sample Sender <${address}>`).text).toBe('Sample Sender <[address removed]>');
    const quoted = '"fixture local"' + String.fromCharCode(64) + 'mail.invalid';
    const international = 'δοκιμή' + String.fromCharCode(64) + 'παράδειγμα.invalid';
    expect(clean(quoted).text).toBe('[address removed]');
    expect(clean(international).text).toBe('[address removed]');
    expect(clean(`first ${address}, second ${address}`).addressRedactions).toBe(2);
    expect(clean('This prose and its accents: café.').text).toBe('This prose and its accents: café.');
  });

  it('normalizes encoded addresses before filtering and suppresses excessive nesting', () => {
    for (const value of [encode(address), encode(encode(address)),
      address.replace(String.fromCharCode(64), '&commat;'),
      address.replace(String.fromCharCode(64), '&#64;'),
      address.replace(String.fromCharCode(64), '&amp;#x40;')]) {
      const result = clean(value);
      expect(result.text).toBe('[address removed]'); expect(result.addressRedactions).toBe(1);
    }
    let nested = address;
    for (let i = 0; i < 5; i++) nested = nested.replaceAll('%', '%25').replace(String.fromCharCode(64), '%40');
    expect(clean(nested)).toMatchObject({ text: '[line removed by the secret gate]', suppressedLines: 1 });
    expect(clean('safe\n%FFhidden\nsafe').text).toBe('safe\n[line removed by the secret gate]\nsafe');
  });

  it('removes invisible joins and compatibility forms before address and secret checks', () => {
    const split = address.replace('fixture', 'fix\u200bture');
    expect(clean(split).text).toBe('[address removed]');
    expect(clean(address.replace(String.fromCharCode(64), '\uff20')).text).toBe('[address removed]');
    expect(clean(`pass\u200bword = ${marker}`).text).toBe('[secret removed]');
    expect(clean('a\r\nb\rc\u2028d\u2029e\u0000f').text).toBe('a\nb\nc\nd\nef');
  });

  it('decodes every named reference the HTML standard defines, not a short list', () => {
    expect(clean('Caf&eacute; &mdash; &rarr; &check; &hearts; &fjlig;ord &lsqb;1&rsqb;').text)
      .toBe('Café — → ✓ ♥ fjord [1]');
    expect(clean('Tom&nbsp;&amp;&nbsp;Jerry &amp;&amp;&amp; &#8217;&#x2019;').text).toBe('Tom & Jerry &&& ’’');
  });

  it('drops zero-width references and raw characters, and collapses preheader padding to one space', () => {
    expect(clean('Zero&zwnj;width&zwj;joins&ZeroWidthSpace;and&NoBreak;words&shy;here').text)
      .toBe('Zerowidthjoinsandwordshere');
    expect(clean('Your digest' + '&zwnj;&nbsp;'.repeat(300) + 'Top posts').text).toBe('Your digest Top posts');
    expect(clean('Preview' + '&nbsp;&#847;&#x2800;&zwnj;'.repeat(100) + 'Body').text).toBe('Preview Body');
    expect(clean('in\u200bvis\u200cible\u200d jo\u2060in\ufeffed').text).toBe('invisible joined');
    expect(clean('wide \u200b \u200c \u200d \u2060 \ufeff gap').text).toBe('wide gap');
    expect(clean('\ufeffStarts with a byte order mark').text).toBe('Starts with a byte order mark');
    expect(clean('Prix\u00a0:\u00a0\u00a010\u202f€').text).toBe('Prix : 10 €');
  });

  it('leaves no space where padding with an invisible character ends a line, and one after no-break spaces', () => {
    expect(clean('Top posts' + '&zwnj;&nbsp;'.repeat(5) + '\r\nNext line').text).toBe('Top posts\nNext line');
    expect(clean('Ends here &zwnj;').text).toBe('Ends here');
    expect(clean('Line\u00a0\u00a0\nNext').text).toBe('Line \nNext');
  });

  it('keeps runs of ASCII spaces and tabs as written', () => {
    const aligned = 'Name:    Value\n\tTabbed  twice\n    indented';
    expect(clean(aligned).text).toBe(aligned);
  });

  it('reads only the standard\'s names, never a name an object inherits', () => {
    const text = 'a &constructor; b &toString; c &valueOf; d &hasOwnProperty;';
    expect(clean(text)).toMatchObject({ text, suppressedLines: 0 });
  });

  it.each([
    'GOCSPX-' + marker, 'ya29.' + marker, '1//0' + marker,
    'ghp_' + marker, 'github_pat_' + marker, 'xoxb-' + marker,
    'AKIA' + 'A1'.repeat(8), 'ASIA' + 'A1'.repeat(8),
    'sk-ant-' + marker, 'sk-proj-' + marker, 'sk-' + marker,
    'fc-' + 'a'.repeat(32), 'tvly-' + marker, 'AIza' + marker,
    're_' + 'A'.repeat(6) + '_' + marker, 'whsec_' + marker,
    'sk_live_' + marker, 'rk_test_' + marker,
    'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    marker,
  ])('replaces an inert credential shape without keeping the match', (value) => {
    const result = clean('Before ' + value + ' after');
    expect(result.text).toBe('Before [secret removed] after');
    expect(result.secretRedactions).toBe(1); expect(result.text).not.toContain(value);
  });

  it.each([
    `password = "short value with spaces"`, 'api_key: fixture-value',
    'access_token=fixture-value', 'refresh-token = fixture-value', 'client_secret: fixture-value',
    'Authorization: Bearer fixture-value', 'Cookie: fixture-value', 'Set-Cookie: fixture-value',
    'export DATABASE_URL=postgresql://user:fixture-value@host.invalid/db',
    'https://host.invalid/path?token=fixture-value',
    'https://user:fixture-value@host.invalid/path', 'sshpass -p fixture-value command',
    'one time code: 123456', 'verification code = 123456',
  ])('removes the entire credential assignment or authenticated URL line', (value) => {
    const result = clean(`safe before\n${value}\nsafe after`);
    expect(result.text).toBe('safe before\n[secret removed]\nsafe after');
    expect(result.secretRedactions).toBe(1);
  });

  it('suppresses residual cues independently of the shape replacement layer', () => {
    for (const value of ['A password follows in prose', 'ssh-ed25519 fixture-public-material',
      'BEGIN PRIVATE KEY fragment', 'API token supplied out of band']) {
      expect(clean(value)).toMatchObject({ text: '[line removed by the secret gate]', suppressedLines: 1 });
    }
    expect(clean('An ordinary budget line.').suppressedLines).toBe(0);
  });
  it('suppresses multiline credential values after their label', () => { for (const label of ['password:', 'api_key: |', 'token="unfinished']) { const result = clean(label + '\nfixture-sensitive-value\ntrailing text'); expect(result.text).not.toContain('fixture-sensitive-value'); expect(result.text).not.toContain('trailing text'); expect(result.suppressedLines).toBe(2); } });
  it('removes the value a gated line introduces on the next line: "Your password is:" and "Your new password is" before "hunter2"', () => {
    for (const input of ['Your password is:\nhunter2', 'Your new password is\nhunter2']) {
      const result = clean(input);
      expect(result.text).not.toContain('hunter2');
      expect(result).toMatchObject({ text: `${gate}\n${gate}`, suppressedLines: 2 });
    }
  });
  it.each([
    'Your password is:', 'Your new password is', 'The Wi-Fi passwords are', 'The old API key was', 'The passwords were',
    'Your new password will be', 'Your password has been changed to', 'Your private key is below',
  ])('removes the value after an introduction that ends with a colon or a word such as is, are or was: "%s"', (line) => {
    expect(clean(line + '\nhunter2\n\nThe meeting moved to Friday.')).toMatchObject({
      text: `${gate}\n${gate}\n\nThe meeting moved to Friday.`, suppressedLines: 2,
    });
  });
  it('keeps the next line after a gated line that only mentions a password: "Reset your password from Settings."', () => {
    for (const prose of ['Reset your password from Settings.', 'Is your password manager synced?',
      'What is the password policy']) {
      expect(clean(prose + '\nThe meeting moved to Friday.')).toMatchObject({
        text: `${gate}\nThe meeting moved to Friday.`, suppressedLines: 1,
      });
    }
  });
  it('removes a value after a blank line and the rest of its paragraph, which a blank line or a change of quote depth ends', () => {
    expect(clean('Your temporary password is:\n\nXy7kP2\n\nSign in from the usual page.')).toMatchObject({
      text: `${gate}\n\n${gate}\n\nSign in from the usual page.`, suppressedLines: 2,
    });
    expect(clean('The passwords are:\nRouter alpha-1\nNAS beta-2\n\nThanks')).toMatchObject({
      text: `${gate}\n${gate}\n${gate}\n\nThanks`, suppressedLines: 3,
    });
    expect(clean('> Your password is:\n>\n> hunter2\n> NAS beta-2\nGot it, thanks.')).toMatchObject({
      text: `> ${gate}\n>\n> ${gate}\n> ${gate}\nGot it, thanks.`, suppressedLines: 3,
    });
  });
  it('keeps the quote markers on every mark: a credential tail, a private-key block, unresolved encoding and an overlong line', () => {
    expect(clean('> password:\n> fixture-sensitive-value\n> > trailing text').text)
      .toBe(`> [secret removed]\n> ${gate}\n> > ${gate}`);
    expect(clean('> -----BEGIN PRIVATE KEY-----\n> ' + marker + '\n> -----END PRIVATE KEY-----\n> next').text)
      .toBe('> [secret removed]\n> [secret removed]\n> [secret removed]\n> next');
    expect(clean('> Old discussion\n> %FF').text).toBe(`> Old discussion\n> ${gate}`);
    expect(clean('>> &' + 'amp;'.repeat(4) + 'zwnj;tail').text).toBe(`>> ${gate}`);
    expect(clean('> ' + 'x'.repeat(65_537)).text).toBe(`> ${gate}`);
  });
  it('removes complete and unterminated private-key blocks across lines', () => {
    const key = ['-----BEGIN PRIVATE KEY-----', marker, '-----END PRIVATE KEY-----'].join('\n');
    const result = clean('safe\n' + key + '\nnext');
    expect(result.text).not.toContain(marker); expect(result.text).not.toContain('PRIVATE KEY');
    expect(result.text.startsWith('safe\n')).toBe(true); expect(result.text.endsWith('\nnext')).toBe(true);
    const unterminated = clean('safe\n-----BEGIN RSA PRIVATE KEY-----\n' + marker + '\ntrailing text');
    expect(unterminated.text).not.toContain(marker); expect(unterminated.text).not.toContain('trailing text');
    const encoded = clean(encode('-----BEGIN PRIVATE KEY-----\n' + marker + '\n-----END PRIVATE KEY-----'));
    expect(encoded.text).not.toContain(marker); expect(encoded.text).not.toContain('PRIVATE KEY');
  });

  it('sanitizes every retained header and omits Bcc and arbitrary provider fields', () => {
    const result = sanitizeMailHeaders([
      { name: 'Subject', value: 'Z'.repeat(230) },
      { name: 'From', value: `Sample Sender <${address}>` },
      { name: 'To', value: address }, { name: 'to', value: address },
      { name: 'Cc', value: 'token=' + marker },
      { name: 'Date', value: `untrusted ${address}` },
      { name: 'Bcc', value: 'never retained' }, { name: 'X-Private', value: 'never retained' },
    ], policy);
    expect(Object.keys(result)).toEqual(['subject', 'date', 'from', 'to', 'cc']);
    expect(result.subject).toHaveLength(200);
    expect(result.from).toBe('Sample Sender <[address removed]>');
    expect(result.to).toBe('[address removed], [address removed]');
    expect(result.cc).toBe('[secret removed]'); expect(result.date).toBe('untrusted [address removed]');
    expect(JSON.stringify(result)).not.toContain('never retained');
    expect(sanitizeMailHeaders([], policy)).toEqual({ subject: '', date: '', from: '', to: '', cc: '' });
  });

  it('uses the same field gate for filenames, label names, titles and folded metadata', () => {
    for (const value of [address + '.pdf', encode(address), 'api_key=' + marker]) {
      const result = sanitizeMailMetadata(value, { ...policy, maxOutputCharacters: 200 });
      expect(result.text).not.toContain(address); expect(result.text).not.toContain(marker);
    }
    expect(sanitizeMailMetadata('Subject\r\n folded\ttext', policy).text).toBe('Subject folded text');
    expect(sanitizeMailHeaders([{ name: 'Subject', value: 'one' }, { name: 'SUBJECT', value: 'two' }], policy).subject)
      .toBe('one');
  });

  it('checks complete input before output clipping and preserves UTF-16 boundaries', () => {
    const result = sanitizeMailText('password=' + marker, { ...policy, maxOutputCharacters: 8 });
    expect(result.text).toBe('[secret '); expect(result.truncated).toBe(true);
    expect(sanitizeMailText('ab😀z', { ...policy, maxOutputCharacters: 3 }))
      .toMatchObject({ text: 'ab', truncated: true });
    expect(sanitizeMailText('ab😀z', { ...policy, maxOutputCharacters: 4 }).text).toBe('ab😀');
    expect(clean('x'.repeat(65_537))).toMatchObject({ text: '[line removed by the secret gate]', suppressedLines: 1 });
    expect(() => clean('x'.repeat(2_097_153))).toThrow('gmail_text_input_too_large');
    expect(() => sanitizeMailHeaders(Array.from({ length: 1001 }, () => ({ name: 'X', value: '' })), policy))
      .toThrow('gmail_text_input_too_large');
    expect(() => sanitizeMailHeaders([{ name: 'Subject', value: 'x'.repeat(2_097_153) }], policy))
      .toThrow('gmail_text_input_too_large');
  });

  it('fails closed on invalid policies and never includes source text in its fault', () => {
    for (const patch of [{ maxInputCharacters: 0 }, { maxLineCharacters: 65_537 },
      { maxOutputCharacters: Infinity }, { maxOutputCharacters: 2_097_153 }, { maxLineCharacters: 1.5 }]) {
      expect(() => sanitizeMailText('private fixture', { ...policy, ...patch })).toThrow('gmail_text_configuration');
    }
    const fault = new GmailTextFault('input_too_large');
    expect(fault.message).toBe('gmail_text_input_too_large'); expect(fault.reason).toBe('input_too_large');
  });
  it('handles long non-address tokens before a real address in bounded input', () => { const body = 'Z'.repeat(60_000) + ' ' + address; expect(clean(body).text).toBe('Z'.repeat(60_000) + ' [address removed]'); });
  it('is text-idempotent at a sufficient cap and has no logging or network side effect', () => {
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected_network'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const input of [address, encode(address), 'token=' + marker, 'Before sk-' + marker + ' after',
        'plain\n\ntext', '-----BEGIN PRIVATE KEY-----\n' + marker, 'Your password is:\n\nhunter2\nmore\n\nNext',
        '> Old discussion\n> %FF', '> password:\n> value', '> -----BEGIN PRIVATE KEY-----\n> ' + marker]) {
        const once = clean(input).text;
        expect(clean(once).text).toBe(once);
      }
      expect(send).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { send.mockRestore(); log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });

  it.each([
    'DB_PASSWORD=fixture-value', 'PGPASSWORD=fixture-value', 'dbPassword: fixture-value', 'Passwords: fixture-value',
    'SSH_PASSPHRASE=fixture-value', 'JWT_SECRET=fixture-value', 'GITHUB_TOKEN=fixture-value',
    'MY_API_KEY=fixture-value', 'AWS_SECRET_ACCESS_KEY=fixture-value', 'authToken: fixture-value',
    'jwtSecret = fixture-value', 'stripeApiKey: fixture-value', 'SECRET_KEY=fixture-value',
    'secretKey: fixture-value', 'emailVerificationCode: 123456',
  ])('removes a credential assignment whose label is part of an identifier or plural', (value) => {
    expect(clean(`safe before\n${value}\nsafe after`)).toMatchObject({
      text: 'safe before\n[secret removed]\nsafe after', secretRedactions: 1,
    });
  });

  it('suppresses joined and plural credential cues and keeps words that merely contain a label or shape prefix', () => {
    for (const value of ['The DB_PASSWORD rotates weekly', 'Both passwords rotate weekly', 'Set PGPASSWORD first',
      'The rsaPrivateKey stays offline', 'Rotate the googleApiKey weekly']) {
      expect(clean(value)).toMatchObject({ text: '[line removed by the secret gate]', suppressedLines: 1 });
    }
    for (const prose of ['Passwordless sign-in, risk-adjusted returns and task-oriented teams.',
      'Compass: north, bypass: closed, tokens: 5, secretary: on leave, preauthorization: required.']) {
      expect(clean(prose)).toMatchObject({ text: prose, secretRedactions: 0, suppressedLines: 0 });
    }
  });

  it('suppresses a named reference left by nesting deeper than the decoding passes', () => {
    const nested = address.replace(String.fromCharCode(64), '&' + 'amp;'.repeat(4) + 'commat;');
    expect(clean(nested)).toMatchObject({
      text: '[line removed by the secret gate]', suppressedLines: 1, addressRedactions: 0,
    });
    expect(clean('Tom &amp;amp; Jerry').text).toBe('Tom & Jerry');
    expect(clean('safe\n&' + 'amp;'.repeat(4) + 'zwnj;tail')).toMatchObject({
      text: 'safe\n[line removed by the secret gate]', suppressedLines: 1,
    });
  });

  it('scans long lines built to backtrack in linear time', () => {
    const lines = ['a.'.repeat(32_768), 'eyJ-'.repeat(16_384), '&a'.repeat(32_768)];
    const input = [...lines, ...lines].join('\n');
    const started = performance.now();
    const result = sanitizeMailText(input, { ...policy, maxOutputCharacters: policy.maxInputCharacters });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ text: input, truncated: false });
  });
});

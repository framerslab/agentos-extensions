---
'@framers/agentos-ext-gmail-source': patch
---

A one-time code is a credential. `sanitizeMailText` kept the six digits of `Your sign-in code is 482913` while the
same mail's link token became `[secret removed]`, since only an assignment (`verification code: 482913`) took a code,
whole line and all. Now a run of four to eight digits, as one run or in equal groups of two, three or four joined by a
space or a hyphen, beside the words that name a sign-in, login, verification, security, authentication, confirmation,
one-time or two-factor code or passcode, a one-time password or PIN, `passcode`, `OTP`, or `your … code` with up to two
words between (`Your Apple ID Code`, `Your WhatsApp code`; a ZIP, postal, area, country or dialling code is none),
becomes `[secret removed]` in place, and the words stay. The digits may follow the words, past `is`, a colon, an equals
sign, a dash or an opening quote or bracket, or precede them (`482913 is your Instagram code`). Digits alone on a line,
as an HTML mail's code box becomes once its tags are stripped, are a code within six lines holding text after a line
that names one, at that line's quote depth. A longer run of digits, such as a telephone number, is not a code, and
digits beside other words stay (`40 people`, `24 October 2026`, `$1,200.00`, `2831 St Rose Parkway`, `ZIP code 89052`).
A thread whose normalized text changes this way gets a new `contentHash` and version, and the store writes its copy
again at the next read.

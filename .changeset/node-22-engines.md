---
'@framers/agentos-ext-calendar-google': patch
'@framers/agentos-ext-channel-blog-publisher': patch
'@framers/agentos-ext-channel-feishu': patch
'@framers/agentos-ext-channel-google-chat': patch
'@framers/agentos-ext-channel-imessage': patch
'@framers/agentos-ext-channel-irc': patch
'@framers/agentos-ext-channel-line': patch
'@framers/agentos-ext-channel-matrix': patch
'@framers/agentos-ext-channel-mattermost': patch
'@framers/agentos-ext-channel-nextcloud': patch
'@framers/agentos-ext-channel-nostr': patch
'@framers/agentos-ext-channel-pinterest': patch
'@framers/agentos-ext-channel-reddit': patch
'@framers/agentos-ext-channel-signal': patch
'@framers/agentos-ext-channel-slack': patch
'@framers/agentos-ext-channel-sms': patch
'@framers/agentos-ext-channel-teams': patch
'@framers/agentos-ext-channel-telegram': patch
'@framers/agentos-ext-channel-tiktok': patch
'@framers/agentos-ext-channel-tlon': patch
'@framers/agentos-ext-channel-twitch': patch
'@framers/agentos-ext-channel-webchat': patch
'@framers/agentos-ext-channel-whatsapp': patch
'@framers/agentos-ext-channel-youtube': patch
'@framers/agentos-ext-channel-zalo': patch
'@framers/agentos-ext-channel-zalouser': patch
'@framers/agentos-ext-email-gmail': patch
'@framers/agentos-ext-github': patch
'@framers/agentos-ext-image-generation': patch
'@framers/agentos-ext-telegram': patch
'@framers/agentos-ext-telegram-bot': patch
'@framers/agentos-ext-voice-plivo': patch
'@framers/agentos-ext-voice-telnyx': patch
'@framers/agentos-ext-voice-twilio': patch
---

Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

/**
 * @fileoverview The Slack read as an account source, for one public Slack app every workspace installs: its bot OAuth
 * v2 grant with the exact scope set and token rotation; the events route's signature check, envelope parse and
 * pushed-event intake; the per-method ceilings by the installation's tier; the capped Web API client under the
 * account-source quota; the channel-day document; and the connector with its resumable sync provider, composed with
 * the account-source coordinator.
 * @module agentos-ext-slack-source
 */

export {
  SLACK_READ_SCOPES, SLACK_SELECTION_MODES, SLACK_DEFAULT_MODE, SLACK_DAY_MS, isSlackRetainedDays,
  isSlackSelectionMode, isSlackTime, isSlackChannelId, slackTsMs, slackTs, compareSlackTs, slackDayOf, slackDayStart,
  channelDayId, parseChannelDayId, slackReadFrom,
  type SlackSelectionMode, type SlackChannelDay,
} from './types.js';
export {
  SLACK_METHODS, slackCeilings, slackQuotaWeights, slackTier,
  type SlackMethod, type SlackTier, type SlackCeiling,
} from './ceilings.js';
export { SLACK_SIGNATURE_SKEW_MS, verifySlackSignature, type SlackSignatureCheck, type SlackSignedRequest } from './signature.js';
export {
  SLACK_ENVELOPE_BYTES, SlackEnvelopeFault, parseSlackEnvelope, slackRetryOf, slackEventSources, enqueueSlackEvent,
  type SlackEnvelope, type SlackEvent, type SlackChannelEventType, type SlackEventIntake,
} from './events.js';
export {
  SLACK_MESSAGE_CHARACTERS, parseSlackMessage, slackMessageVersion, slackPeopleOf, isKeptSubtype,
  type SlackMessage,
} from './messages.js';
export {
  SLACK_DAY_MESSAGES, SLACK_DAY_CHARACTERS, mapChannelDay, channelDayTitle, channelDayExpiry, resolveSlackText,
  type SlackDayInput, type SlackDayRender,
} from './mapChannelDay.js';
export {
  SlackOAuthFlow, SlackOAuthFault, slackOAuthFault, SLACK_UNAVAILABLE_ERRORS,
  type SlackOAuthClient, type SlackOAuthEndpoints, type SlackOAuthOptions, type SlackOAuthFailure,
  type SlackGrantCleanup, type SlackGrant,
} from './oauth.js';
export {
  SlackApi, SlackApiFault, parseSlackChannel,
  type SlackApiOptions, type SlackChannel, type SlackPage, type SlackPerson, type SlackTeam, type SlackIdentity,
  type SlackHistoryRange,
} from './slack.js';
export {
  SLACK_CHANNEL_LEFT, SLACK_WALK_DAYS, readSlackDay, slackWithin, slackAdmission, slackChannelAnchor, slackBeginAnchor,
  slackWindowSlice, slackHeldDays,
  type SlackDayMessages, type SlackWait,
} from './history.js';
export {
  SlackSourceConnector, SlackConnectorFault, slackOperationMs,
  type SlackSourceConnectorOptions, type SlackHeldDay,
} from './SlackSourceConnector.js';
export { slackSourceSync, runSlackSourceSync, type SlackSourceRunOptions } from './sync.js';

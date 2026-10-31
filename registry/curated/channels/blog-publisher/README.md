# Blog publisher channel

This pack gives an agent tools for publishing, updating, listing, cross-posting, scheduling and retrieving article analytics on Dev.to, Hashnode, Medium and WordPress through `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-blog-publisher
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-blog-publisher',
        options: {
          devto: { apiKey: process.env.DEVTO_API_KEY },
          hashnode: {
            apiKey: process.env.HASHNODE_API_KEY,
            publicationId: process.env.HASHNODE_PUBLICATION_ID,
          },
          medium: {
            accessToken: process.env.MEDIUM_ACCESS_TOKEN,
            authorId: process.env.MEDIUM_AUTHOR_ID,
          },
          wordpress: {
            url: process.env.WORDPRESS_URL,
            username: process.env.WORDPRESS_USERNAME,
            appPassword: process.env.WORDPRESS_APP_PASSWORD,
          },
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then environment variables. A platform is enabled by its primary credential, or its URL for WordPress.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `devto.apiKey` | `devto.apiKey` | `DEVTO_API_KEY` | No | Unset |
| `hashnode.apiKey` | `hashnode.apiKey` | `HASHNODE_API_KEY` | No | Unset |
| `hashnode.publicationId` | `hashnode.publicationId` | `HASHNODE_PUBLICATION_ID` | Yes, for Hashnode publishing and listing | Unset |
| `medium.accessToken` | `medium.accessToken` | `MEDIUM_ACCESS_TOKEN` | No | Unset |
| `medium.authorId` | `medium.authorId` | `MEDIUM_AUTHOR_ID` | No | Resolved through `/me` when publishing |
| `wordpress.url` | `wordpress.url` | `WORDPRESS_URL` | No | Unset |
| `wordpress.username` | `wordpress.username` | `WORDPRESS_USERNAME` | No | Unset |
| `wordpress.appPassword` | `wordpress.appPassword` | `WORDPRESS_APP_PASSWORD` | No | Unset |
| `secrets` | None | None | No | `{}` |
| `priority` | None | None | No | `50` |

## Tools

| Tool | What it does |
| --- | --- |
| `blogPublishArticle` | Publishes a Markdown article to specified or configured blog platforms. |
| `blogUpdateArticle` | Updates an article on Dev.to, Hashnode or WordPress. |
| `blogListArticles` | Lists published and draft articles from specified or configured platforms. |
| `blogAnalytics` | Retrieves article views, reactions and comments from Dev.to. |
| `blogSchedule` | Saves an article with scheduling metadata for an external scheduler to publish. |
| `blogCrossPost` | Fetches an article from a URL and publishes it with a canonical URL pointing to the source. |

### `blogPublishArticle`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | Yes | Article title |
| `body` | string | Yes | Article body in Markdown format |
| `tags` | array of string | No | Tags/topics for the article |
| `platforms` | array of string: `devto`, `hashnode`, `medium`, `wordpress` | No | Target platforms. Defaults to all configured. |
| `coverImage` | string | No | URL of the cover image |
| `published` | boolean | No | If true, publish immediately. If false, save as draft. Defaults to false. |
| `canonicalUrl` | string | No | Canonical URL for SEO (original source) |
| `series` | string | No | Series name (Dev.to only) |

### `blogUpdateArticle`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | string: `devto`, `hashnode`, `wordpress` | Yes | Target platform |
| `articleId` | string | Yes | Platform-specific article/post ID |
| `title` | string | No | Updated title |
| `body` | string | No | Updated body in Markdown |
| `tags` | array of string | No | Updated tags |
| `published` | boolean | No | Change publish status |
| `coverImage` | string | No | Updated cover image URL |
| `canonicalUrl` | string | No | Updated canonical URL |
| `series` | string | No | Updated series name (Dev.to only) |

### `blogListArticles`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | string: `devto`, `hashnode`, `wordpress` | No | Platform to list from. Omit to list from all configured platforms. |
| `limit` | number | No | Maximum number of articles to return per platform. Defaults to 30. |

### `blogAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | string: `devto` | Yes | Platform to retrieve analytics from |
| `articleId` | string | Yes | Platform-specific article ID |

### `blogSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | Yes | Article title |
| `body` | string | Yes | Article body in Markdown format |
| `tags` | array of string | No | Tags/topics for the article |
| `platforms` | array of string: `devto`, `hashnode`, `medium`, `wordpress` | No | Target platforms. Defaults to all configured. |
| `scheduledTime` | string | Yes | ISO 8601 datetime for when the article should be published |
| `coverImage` | string | No | URL of the cover image |
| `canonicalUrl` | string | No | Canonical URL for SEO |
| `series` | string | No | Series name (Dev.to only) |

### `blogCrossPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sourceUrl` | string | Yes | URL of the original article to cross-post |
| `platforms` | array of string: `devto`, `hashnode`, `medium`, `wordpress` | No | Target platforms. Defaults to all configured. |
| `tags` | array of string | No | Tags to apply to the cross-posted article |
| `title` | string | No | Override the article title. If omitted, extracted from the source page. |
| `published` | boolean | No | If true, publish immediately. If false, save as draft. Defaults to false. |
| `coverImage` | string | No | Cover image URL (overrides source) |

## Channel adapter

The adapter registers platform `devto`. Initialization checks for configured platforms and marks the adapter connected. Sending publishes the first text block as an article. The `conversationId` selects `all`, a platform name or comma-separated platform names. `platformOptions` accepts `title`, `tags`, `published`, `coverImage`, `canonicalUrl` and `series`; the title defaults to `Untitled`. The adapter does not receive events.

## Notes

Publishing, updating, cross-posting and scheduling create or modify remote articles. Without configured credentials, activation logs a warning and skips adapter initialization. Accessing an unconfigured platform fails.

Scheduling adds an HTML comment to the body and requires a future time and an external scheduler. Hashnode uses its publish mutation regardless of `published`, including for scheduled articles. Its update path ignores publish status and series. Medium does not support updating or listing through this service. Analytics is restricted to Dev.to.

Cross-posting extracts raw HTML from an article, main or body element without converting it to Markdown. Source requests time out after `15000` ms. WordPress receives the body directly as content, tag strings as `tags` and the cover image value as `featured_media`. Its publish and update paths do not forward the canonical URL. Hashnode listing ignores `limit`. Listing all configured platforms discards failed platform results; publishing returns per-platform errors.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0

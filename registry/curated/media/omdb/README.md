# OMDB movie and TV lookup

This pack gives an agent title search and detail lookups for movies, TV shows, and episodes through the Open Movie Database API. Detail results include cast, crew, plot, ratings, and box office data.

## Installation

```bash
npm install @framers/agentos-ext-omdb
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-omdb',
        options: { omdbApiKey: process.env.OMDB_API_KEY },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `omdbApiKey` | `omdb.apiKey` | `OMDB_API_KEY` | Yes | Empty string |
| `priority` | None | None | No | `50` |

The key resolves from `omdbApiKey`, then `getSecret('omdb.apiKey')`, then `OMDB_API_KEY`. Tool descriptors declare `omdb.apiKey` as a required secret. Obtain a key from [OMDB's API key page](https://www.omdbapi.com/apikey.aspx).

## Tools

| Tool | What it does |
| --- | --- |
| `omdb_search` | Searches movies, TV shows, and episodes by title and returns metadata with IMDB ids. |
| `omdb_details` | Gets movie, TV show, or episode details by IMDB id or title. |

### `omdb_search`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Title search string for movies, TV shows, or episodes. |
| `year` | `integer` | No | Optional release year to narrow results. |
| `type` | `string`, enum: `movie`, `series`, `episode` | No | Optional media type filter. |
| `page` | `integer` | No | Page number for paginated results (10 results per page). |

The `page` schema has minimum and default `1`.

### `omdb_details`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imdbId` | `string` | No | IMDB identifier (e.g. "tt1375666"). Takes precedence over title. |
| `title` | `string` | No | Title to look up. Used when `imdbId` is not provided. |
| `year` | `integer` | No | Optional release year to disambiguate titles. |
| `plot` | `string`, enum: `short`, `full` | No | Length of the plot summary. |

The `plot` schema defaults to `short`. Execution requires either `imdbId` or `title`.

## Notes

Requests use `http://www.omdbapi.com/` with the API key in the query string. The factory accepts a missing key and passes an empty string to the service. HTTP failures and API error responses become tool errors, including searches with no results.

Search returns `results` and `totalResults`. Details normalize missing metadata to empty strings or `N/A` and missing ratings to an empty array. Both tools have no write side effects and declare `capability:media_search`.

## License

Apache-2.0

# Trulia Property Search

Search real estate properties on Trulia by location, price, bedrooms, and property type.

## Installation

```bash
npm install @framers/agentos-ext-trulia-search
```

## Usage

```typescript
import { createExtensionPack } from '@framers/agentos-ext-trulia-search';

const pack = createExtensionPack({
  config: {
    truliaRapidApiKey: process.env.TRULIA_RAPIDAPI_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY, // fallback
  },
});
```

## Tool: `trulia_search`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `location` | string | Yes | City, state or zip code (e.g., "Austin, TX") |
| `propertyType` | string | No | house, apartment, condo, townhouse, land |
| `minPrice` | number | No | Minimum price filter |
| `maxPrice` | number | No | Maximum price filter |
| `bedrooms` | number | No | Minimum bedrooms |
| `bathrooms` | number | No | Minimum bathrooms |
| `maxResults` | number | No | Maximum results (default: 20) |

### Example

```
User: "Find 3-bedroom houses in Austin under $400k"
Tool call: trulia_search({
  location: "Austin, TX",
  propertyType: "house",
  bedrooms: 3,
  maxPrice: 400000
})
```

## Data Sources

1. **RapidAPI Trulia** (preferred) — structured property data via `TRULIA_RAPIDAPI_KEY`
2. **Firecrawl scrape** (fallback) — scrapes trulia.com search results when no RapidAPI key is available. Requires `FIRECRAWL_API_KEY`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRULIA_RAPIDAPI_KEY` | No | RapidAPI key for structured Trulia data |
| `FIRECRAWL_API_KEY` | No | Firecrawl key for scrape fallback |

At least one key is needed for results. Without either, the tool returns empty listings.

## License

Apache-2.0

# Weather

This pack gives an agent current weather and forecast lookup through WeatherAPI.com with an Open-Meteo fallback. It uses `fetch` and resolves locations through the Open-Meteo Geocoding API.

## Installation

```bash
npm install @framers/agentos-ext-weather
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-weather',
        options: {
          weatherApiKey: process.env.WEATHERAPI_KEY,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `weatherApiKey` | `weather.weatherApiKey` | `WEATHERAPI_KEY` | no | Unset; uses Open-Meteo |
| `priority` | None | None | no | `50` |

The key resolves from a truthy `weatherApiKey`, then `context.getSecret('weather.weatherApiKey')`, then `WEATHERAPI_KEY`.

## Tools

| Tool | What it does |
| --- | --- |
| `weather_lookup` | Returns current conditions and forecasts with temperature, humidity, wind, precipitation, UV and provider-supplied alerts. |

### `weather_lookup`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `location` | string | yes | City name, zip code, or lat,lon coordinates (e.g. "Las Vegas", "90210", "36.17,-115.14") |
| `days` | integer, minimum `1`, maximum `14`, default `3` | no | Number of forecast days (`1` to `14`, default `3`) |

## Notes

The tool declares `capability:web_access`. It trims `location` and returns an error for an empty value. All location strings go to the geocoder's name search; the service does not separately parse zip codes or coordinate strings. A missing geocoding result fails the lookup.

With a key, the service tries WeatherAPI.com first and falls back to Open-Meteo on any WeatherAPI error. Without a key, it uses Open-Meteo. WeatherAPI requests are capped at `3` forecast days; Open-Meteo requests are capped at `16`, while the tool schema allows up to `14`. Requests have no explicit timeout in the service.

Alerts are returned only by the WeatherAPI path when present. The Open-Meteo path sets `feels_like_f` to the current temperature and uses the first forecast day's maximum UV as current UV. Results identify the provider and include both Fahrenheit and Celsius temperatures.

## License

Apache-2.0

// @ts-nocheck
import type {
  ExtensionPackContext,
  ExtensionPack,
  ExtensionLifecycleContext,
} from '@framers/agentos';

import { WeatherService } from './services/weatherService.js';
import { WeatherLookupTool } from './tools/weatherLookup.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export interface WeatherExtensionOptions {
  weatherApiKey?: string;
  priority?: number;
}

export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  const options = (context.options ?? {}) as WeatherExtensionOptions;

  const weatherApiKey =
    options.weatherApiKey ||
    context.getSecret?.('weather.weatherApiKey') ||
    process.env.WEATHERAPI_KEY;

  const service = new WeatherService(weatherApiKey);
  const tool = new WeatherLookupTool(service);

  return {
    name: '@framers/agentos-ext-weather',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool',
        priority: options.priority ?? 50,
        payload: tool,
        requiredSecrets: [{ id: 'weather.weatherApiKey', optional: true }],
      },
    ],
    onActivate: async (lc?: ExtensionLifecycleContext) => {
      const provider = service.hasWeatherApiKey
        ? 'WeatherAPI.com (preferred) + Open-Meteo fallback'
        : 'Open-Meteo only (set WEATHERAPI_KEY for WeatherAPI.com)';
      lc?.logger?.info(`Weather Extension activated — ${provider}`);
    },
    onDeactivate: async (lc?: ExtensionLifecycleContext) => {
      lc?.logger?.info('Weather Extension deactivated');
    },
  };
}

export { WeatherService } from './services/weatherService.js';
export { WeatherLookupTool } from './tools/weatherLookup.js';
export type {
  WeatherResult,
  GeoLocation,
  CurrentWeather,
  ForecastDay,
  WeatherAlert,
} from './services/weatherService.js';
export type { WeatherLookupInput } from './tools/weatherLookup.js';
export default createExtensionPack;

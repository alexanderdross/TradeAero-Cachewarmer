import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { AppConfig } from './types';

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const ov = override[key];
    const bv = base[key];
    if (
      ov !== null &&
      typeof ov === 'object' &&
      !Array.isArray(ov) &&
      bv !== null &&
      typeof bv === 'object' &&
      !Array.isArray(bv)
    ) {
      result[key] = deepMerge(
        bv as Record<string, unknown>,
        ov as Record<string, unknown>
      );
    } else {
      result[key] = ov;
    }
  }
  return result;
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const configPath = path.resolve(process.cwd(), 'config.yaml');
  const localPath = path.resolve(process.cwd(), 'config.local.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found at ${configPath}`);
  }

  const base = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  let merged = base;

  if (fs.existsSync(localPath)) {
    const local = yaml.load(fs.readFileSync(localPath, 'utf8')) as Record<string, unknown>;
    merged = deepMerge(base, local);
  }

  _config = merged as unknown as AppConfig;
  return _config;
}

/** Returns the list of channel names that are enabled in config. */
export function getEnabledChannels(config: AppConfig): import('./types').ChannelName[] {
  const channels: import('./types').ChannelName[] = [];
  if (config.cdn.enabled)       channels.push('cdn');
  if (config.cloudflare.enabled) channels.push('cloudflare');
  if (config.vercel.enabled)    channels.push('vercel');
  if (config.facebook.enabled)  channels.push('facebook');
  if (config.linkedin.enabled)  channels.push('linkedin');
  if (config.google.enabled)    channels.push('google');
  if (config.bing.enabled)      channels.push('bing');
  if (config.indexNow.enabled)  channels.push('indexNow');
  return channels;
}

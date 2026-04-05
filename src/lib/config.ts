import { getSupabase } from './supabase';

export type ChannelName = 'cdn' | 'cloudflare' | 'vercel' | 'facebook' | 'linkedin' | 'google' | 'bing' | 'indexnow' | 'twitter' | 'pinterest';

export interface ChannelEntry {
  enabled: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
}

export interface ServiceConfig {
  cachwarmerEnabled: boolean;
  indexingEnabled: boolean;
  sitemapUrl: string;
  channels: Partial<Record<ChannelName, ChannelEntry>>;
  orchestration: ChannelEntry;
}

export async function loadServiceConfig(): Promise<ServiceConfig> {
  const supabase = getSupabase();

  const [{ data: settings }, { data: configs }] = await Promise.all([
    supabase.from('system_settings').select('key, value'),
    supabase.from('cachewarmer_config').select('service, config, enabled'),
  ]);

  const getSetting = (key: string, def: boolean): boolean => {
    const row = (settings ?? []).find((s: { key: string }) => s.key === key);
    return row !== undefined ? Boolean(row.value) : def;
  };

  const channels: ServiceConfig['channels'] = {};
  let orchestration: ChannelEntry = { enabled: false, config: {} };

  for (const row of configs ?? []) {
    if (row.service === 'orchestration') {
      orchestration = { enabled: row.enabled, config: row.config ?? {} };
    } else {
      channels[row.service as ChannelName] = { enabled: row.enabled, config: row.config ?? {} };
    }
  }

  return {
    cachwarmerEnabled: getSetting('cachewarmer_enabled', true),
    indexingEnabled: getSetting('indexing_enabled', true),
    sitemapUrl: process.env.SITEMAP_URL ?? 'https://trade.aero/sitemap.xml',
    channels,
    orchestration,
  };
}

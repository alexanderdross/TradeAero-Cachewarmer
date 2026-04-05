export interface AppConfig {
  server: {
    port: number;
    apiKey: string;
  };
  orchestration: {
    triggerIndexingAfterWarming: boolean;
    githubPat: string;
    githubOwner: string;
    githubRepo: string;
    githubWorkflow: string;
    githubRef: string;
  };
  cdn: {
    enabled: boolean;
    concurrency: number;
  };
  cloudflare: {
    enabled: boolean;
    apiToken: string;
    zoneId: string;
  };
  vercel: {
    enabled: boolean;
    apiToken: string;
    teamId: string;
  };
  facebook: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    rateLimitPerSecond: number;
  };
  linkedin: {
    enabled: boolean;
    sessionCookie: string;
    concurrency: number;
    delayBetweenRequests: number;
  };
  google: {
    enabled: boolean;
    serviceAccountJson: string;
    dailyQuota: number;
  };
  bing: {
    enabled: boolean;
    apiKey: string;
    dailyQuota: number;
  };
  indexNow: {
    enabled: boolean;
    key: string;
    keyLocation: string;
  };
  redis: {
    host: string;
    port: number;
  };
  supabase: {
    enabled: boolean;
    url: string;
    serviceRoleKey: string;
  };
  logging: {
    level: string;
  };
}

export type ChannelName =
  | 'cdn'
  | 'cloudflare'
  | 'vercel'
  | 'facebook'
  | 'linkedin'
  | 'google'
  | 'bing'
  | 'indexNow';

export interface ChannelJobData {
  jobId: string;
  urls: string[];
  channel: ChannelName;
}

export interface ChannelProgress {
  status: 'pending' | 'running' | 'done' | 'failed';
  urlsTotal: number;
  urlsSuccess: number;
  urlsFailed: number;
}

export interface WarmingJob {
  jobId: string;
  sitemapUrl?: string;
  urls: string[];
  channels: ChannelName[];
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  triggeredBy: 'api' | 'manual';
  progress: Partial<Record<ChannelName, ChannelProgress>>;
}

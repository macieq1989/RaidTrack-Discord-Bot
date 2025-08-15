import 'dotenv/config';

export const cfg = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./data/db.sqlite',
  tz: process.env.TZ ?? 'Europe/London',

  // Routing kanałów
  fallbackChannel: process.env.CH_FALLBACK || process.env.FALLBACK_CHANNEL_ID || '',
  channelRouting: {
    NORMAL: process.env.CH_NORMAL || '',
    HEROIC: process.env.CH_HEROIC || '',
    MYTHIC: process.env.CH_MYTHIC || '',
  },

  // OAuth / Web
  publicUrl: process.env.PUBLIC_URL ?? '',
  oauth: {
    clientId: process.env.OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.OAUTH_CLIENT_SECRET ?? '',
    redirectUri: process.env.OAUTH_REDIRECT_URI ?? '',
    scopes: (process.env.OAUTH_SCOPES ?? 'identify').split(/\s+/).filter(Boolean)
  },
  sessionSecret: process.env.SESSION_SECRET ?? 'change-me',

  // Autoryzacja
  allowedGuildId: process.env.ALLOWED_GUILD_ID ?? '',
  officerRoleId: process.env.OFFICER_ROLE_ID ?? ''
};

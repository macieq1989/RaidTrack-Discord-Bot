import 'dotenv/config';

export const cfg = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '', // for guild-scoped commands
  port: Number(process.env.PORT ?? 8080),
  ingestKey: process.env.API_INGEST_KEY ?? '',
  databaseUrl: process.env.DATABASE_URL ?? 'file:./data/db.sqlite',
  tz: process.env.TZ ?? 'Europe/Warsaw',
  // channel routing by difficulty; keep exact raid title from addon
  channelRouting: {
    NORMAL: process.env.CH_NORMAL ?? '',
    HEROIC: process.env.CH_HEROIC ?? '',
    MYTHIC: process.env.CH_MYTHIC ?? ''
  },
  fallbackChannel: process.env.CH_FALLBACK ?? ''
};

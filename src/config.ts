import 'dotenv/config';

/** Parse EMOJI_MAP / EMOJI_MAP_JSON into a Record<string, string> */
function parseEmojiMap(): Record<string, string> {
  const out: Record<string, string> = {};

  // Highest priority: JSON blob (must be one line in .env)
  const json = process.env.EMOJI_MAP_JSON;
  if (json) {
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim()) out[k.toLowerCase()] = v.trim();
      }
    } catch {
      // ignore malformed JSON, fallback to EMOJI_MAP
    }
  }

  // Fallback: CSV/whitespace-separated "name:ID" or "name=ID"
  if (Object.keys(out).length === 0) {
    const csv = process.env.EMOJI_MAP ?? '';
    for (const token of csv.split(/[,\s]+/).filter(Boolean)) {
      const [k, v] = token.split(/[:=]/);
      if (k && v) out[k.toLowerCase()] = v.trim();
    }
  }

  return out;
}

export const cfg = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./data/db.sqlite',
  tz: process.env.TZ ?? 'Europe/London',

  // Channel routing
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
    scopes: (process.env.OAUTH_SCOPES ?? 'identify')
      .split(/\s+/)
      .filter(Boolean),
  },
  sessionSecret: process.env.SESSION_SECRET ?? 'change-me',

  // Auth
  allowedGuildId: process.env.ALLOWED_GUILD_ID ?? '',
  officerRoleId: process.env.OFFICER_ROLE_ID ?? '',

  // External custom emoji (kept on a separate "emoji server")
  emojiGuildId: process.env.EMOJI_GUILD_ID ?? '',
  allowExternalEmoji: String(process.env.ALLOW_EXTERNAL_EMOJI ?? 'true') === 'true',
  // Map: "class_spec" (lowercase) -> emoji id or full token ("<:name:id>" / "<a:name:id>") or "a:ID"
  customEmoji: parseEmojiMap(),
} as const;

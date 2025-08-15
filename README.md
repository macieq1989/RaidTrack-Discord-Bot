# RaidTrack Discord Bot

Starter scaffold for a Discord bot that imports RaidTrack JSON and publishes raid announcements.

## Quick start

```bash
cp .env.example .env
# fill DISCORD_TOKEN, CLIENT_ID, GUILD_ID
npm install
npx prisma generate
npm run dev
```

Docker:

```bash
docker compose up --build -d
```

Slash commands:
- `/rt-import payload:<JSON>`

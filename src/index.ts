// src/index.ts
import {
  REST, Routes, Client, GatewayIntentBits, Partials, Collection, Events,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type ButtonInteraction,
} from 'discord.js';
import { cfg } from './config.js';
import { createWebServer } from './web.js';
import * as RtImport from './commands/rt-import.js';
import webRoutes from './routes/web.js'; // keep .js extension with NodeNext/ESM
import { startSavedVariablesPoller } from './services/svPoller.js';
import { handleSignupButton } from './services/raidSignup.js';

// Intents: Guilds (wymagane), GuildMembers (nazwy do embedów), GuildMessages (fetch/edytuj msg)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.GuildMember, Partials.Channel, Partials.Message],
});

// === command module type ===
type CommandModule = {
  data: { toJSON: () => RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute: (i: ChatInputCommandInteraction) => Promise<unknown>;
};

// register + router
const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [RtImport.data.toJSON()];
const router = new Collection<string, CommandModule>();
router.set('rt', RtImport as unknown as CommandModule);

let app: ReturnType<typeof createWebServer> | null = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Rejestr komend – jeśli jest guildId, rejestruj lokalnie (szybciej), w innym razie globalnie
  try {
    const rest = new REST({ version: '10' }).setToken(cfg.token);
    if (cfg.guildId) {
      await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commands });
      console.log('Slash commands registered (guild).');
    } else {
      await rest.put(Routes.applicationCommands(cfg.clientId), { body: commands });
      console.log('Slash commands registered (global).');
    }
  } catch (e) {
    console.error('Slash registration failed:', e);
  }

  // Start Fastify ONCE; mount web under /web to avoid "/" conflicts
  app = createWebServer(client);
  await app.register(webRoutes, { prefix: '/web' });
  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  console.log(`HTTP on :${cfg.port}`);

  // SV poller
  startSavedVariablesPoller(client, {
    filePath: process.env.SV_FILE || '/data/RaidTrack.lua',
    key: process.env.SV_EXPORT_KEY || 'RaidTrackExport',
    intervalMs: Number(process.env.SV_POLL_MS ?? 60000),
  });
  console.log('[SV] poller started');
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // najpierw przyciski zapisów:
    if (i.isButton()) {
      if (i.guild) {
        const handled = await handleSignupButton(i as ButtonInteraction, i.guild);
        if (handled) return;
      } else {
        // brak gildii (DM?) – ignoruj
        return;
      }
    }

    if (!i.isChatInputCommand()) return;
    const cmd = router.get(i.commandName);
    if (!cmd) return;

    await cmd.execute(i);
  } catch (e) {
    console.error(e);
    if (i.isRepliable()) {
      if ((i as any).deferred || (i as any).replied) await (i as any).editReply('Command failed.');
      else await (i as any).reply({ content: 'Command failed.', ephemeral: true });
    }
  }
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM: shutting down…');
  try { if (app) await app.close(); } catch {}
  try { client.destroy(); } catch {}
  process.exit(0);
});

client.login(cfg.token);

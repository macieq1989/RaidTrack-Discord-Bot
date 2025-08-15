import { REST, Routes, Client, GatewayIntentBits, Collection, Events, type ChatInputCommandInteraction, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { cfg } from './config.js';
import { createWebServer } from './web.js';
import * as RtImport from './commands/rt-import.js';
import webRoutes from './routes/web.js'; // keep .js extension with NodeNext/ESM
import { startSavedVariablesPoller } from './services/svPoller.js';


const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// === command module type ===
type CommandModule = {
  data: { toJSON: () => RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute: (i: ChatInputCommandInteraction) => Promise<unknown>;
};

// register + router
const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [RtImport.data.toJSON()];
const router = new Collection<string, CommandModule>();
router.set('rt', RtImport as unknown as CommandModule);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commands });
  console.log('Slash commands registered.');

  // Start Fastify ONCE
  const app = createWebServer(client);

  // IMPORTANT: mount webRoutes under a prefix to avoid duplicating GET '/'
  await app.register(webRoutes, { prefix: '/web' });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  console.log(`HTTP on :${cfg.port}`);

  startSavedVariablesPoller(client, {
    filePath: process.env.SV_FILE || '/data/RaidTrack.lua',
    key: process.env.SV_EXPORT_KEY || 'RaidTrackExport',
    intervalMs: Number(process.env.SV_POLL_MS ?? 60000),
  });
  console.log('[SV] poller started');

});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  const cmd = router.get(i.commandName);
  if (!cmd) return;

  try {
    await cmd.execute(i);
  } catch (e) {
    console.error(e);
    if (i.deferred || i.replied) await i.editReply('Command failed.');
    else await i.reply({ content: 'Command failed.', ephemeral: true });
  }
});

client.login(cfg.token);

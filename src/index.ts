import { REST, Routes, Client, GatewayIntentBits, Collection, Events } from 'discord.js';
import { cfg } from './config.js';
import { createWebServer } from './web.js';
import * as RtImport from './commands/rt-import.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [RtImport.data.toJSON()];
const router = new Collection<string, any>();
router.set('rt', RtImport);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // register guild commands
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commands });
  console.log('Slash commands registered.');

  // web server
  const app = createWebServer(client);
  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  console.log(`HTTP on :${cfg.port}`);
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

const { Logger } = require('../utils');

// Bij het inloggen stuurt de server in één keer de hele bestaande spelerslijst, en dat
// vuurt voor elke naam die daar al in staat ook gewoon een 'playerJoined'-event. Zonder
// deze wachttijd zou de bot bij het opstarten iedereen die al online was een welkomst-
// bericht sturen, in plaats van alleen mensen die daadwerkelijk ná de bot binnenkomen.
const WARMUP_MS = 3000;

const GREETING = [
  'Yo! Ik ben een bot en kan nog foutjes maken.',
  'Vind je een bug? Stuur die dan naar Iwein.',
  'Wil je weten wat ik allemaal kan? Kijk op Iwein zijn GitHub, of vraag het gewoon aan Iwein.',
];

function startJoinGreeter(bot) {
  let ready = false;

  // .once: dit hoeft maar één keer ingesteld te worden, ook al vuurt 'spawn' opnieuw bij
  // een respawn — de speler-warmup slaat alleen op het allereerste inloggen.
  bot.once('spawn', () => {
    setTimeout(() => { ready = true; }, WARMUP_MS);
  });

  bot.on('playerJoined', (player) => {
    if (!ready || player.username === bot.username) return;
    Logger.info(`${player.username} kwam binnen, welkomstbericht wordt gestuurd`);
    for (const line of GREETING) bot.chat(line);
  });

  Logger.info('Join-welkomstbericht actief');
}

module.exports = { startJoinGreeter };

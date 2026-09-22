/**
 * Automatische reacties op gewone chatberichten (zonder !).
 *
 * Wordt in Index.js vóór handleCommand aangeroepen en geeft true terug als het bericht
 * afgehandeld is. Daarom staat bovenaan de check op '!': zonder die regel matchte
 * "!follow Iwein" op de iwein-trigger en werd het commando nooit uitgevoerd.
 *
 * REACTIES wordt van boven naar beneden afgelopen, de eerste treffer wint. Zet een specifieke
 * regel dus boven een algemene.
 */

const { CONFIG } = require('../config');
const { Logger, getInventoryStatus } = require('../utils');
const { songBook } = require('../data/songs');
const { fightPlayer } = require('./combat');
const botState = require('../state');

const SONG_LINE_DELAY = 1300;
const STOP_POLL_MS = 100;

// In stukjes wachten in plaats van 1,3 seconde in een keer: anders ziet de lus de stopvlag pas
// nadat de wachttijd afgelopen is, en zingt de bot na !stop nog een regel door.
async function waitBetweenLines() {
  for (let waited = 0; waited < SONG_LINE_DELAY; waited += STOP_POLL_MS) {
    if (botState.stopSinging) return;
    await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS));
  }
}

// isSinging/stopSinging staan in botState en niet meer in een losse variabele hier: !stop in
// features/commands.js moet erbij kunnen. Zonder dat bleef de bot na !stop gewoon uitzingen.
async function singSong(bot) {
  if (botState.isSinging) return;
  botState.isSinging = true;
  botState.stopSinging = false;

  try {
    const song = songBook.getRandom();
    if (!song) return;

    Logger.debug(`Zingt: ${song.name}`);
    for (const line of song.lines) {
      if (botState.stopSinging) break;
      bot.chat(line);
      await waitBetweenLines();
    }
    if (botState.stopSinging) Logger.debug('Zingen afgebroken door !stop');
  } catch (err) {
    Logger.error('Zing error', err);
  } finally {
    botState.isSinging = false;
  }
}

// Elke reactie: regex + functie(bot, username, match) -> void
// Volgorde is belangrijk, de eerste match wint.
const REACTIONS = [
  {
    pattern: /\b(zing|zingen|muziek)\b/i,
    reply: (bot) => singSong(bot),
  },
  {
    pattern: /vecht (tegen|met) (mij|me)\b/i,
    reply: (bot, username) => fightPlayer(bot, username),
  },
  {
    pattern: /^(yo|hey|hallo|hoi|hai|hello|hi)\b/i,
    reply: (bot, username) => bot.chat(`Yo! Hallo ${username}!`),
  },
  {
    pattern: /^(doei|bye|dag|later|tot ziens|cya)\b/i,
    reply: (bot, username) => bot.chat(`Doei ${username}, tot later!`),
  },
  {
    pattern: /(dank je|dankjewel|thanks|thank you|bedankt)/i,
    reply: (bot, username) => bot.chat(`Graag gedaan, ${username}!`),
  },
  {
    pattern: /(hoe gaat het|gaat het goed|how are you)/i,
    reply: (bot) => {
      const hp = bot.health?.toFixed(0) ?? '?';
      const food = bot.food?.toFixed(0) ?? '?';
      bot.chat(`Prima! ${hp}/20 HP, ${food}/20 honger.`);
    },
  },
  {
    pattern: /(goeie bot|good bot|braaf|goed gedaan)/i,
    reply: (bot, username) => bot.chat(`Dankjewel, ${username}! :)`),
  },
  {
    pattern: /wie ben jij|wie ben ik|what's your name|hoe heet je|naam/i,
    reply: (bot) => bot.chat('Ik ben een bot gemaakt door Iwein!'),
  },
  {
    pattern: /iwein|emperor|solaris/i,
    reply: (bot) => bot.chat('ALL HEIL THE EMPEROR SOLARIS'),
  },
  {
    pattern: /(wat is je hp|health|gezondheid)\??$/i,
    reply: (bot) => bot.chat(`Ik heb ${(bot.health ?? 0).toFixed(1)}/${CONFIG.health.maxHealth} HP.`),
  },
  {
    pattern: /(inventory|inventaris|wat heb je)\??$/i,
    reply: (bot) => {
      const status = getInventoryStatus(bot);
      bot.chat(status ? `Inventaris${status}` : 'Inventaris ziet er goed uit!');
    },
  },
];

// Behandelt automatische chat-reacties. Geeft true terug als er iets gematcht is,
// zodat de aanroeper weet dat het bericht al is afgehandeld.
function handleChatReactions(bot, username, message) {
  if (username === bot.username) return false;

  // Een commando is nooit een praatje. Zonder deze regel werd de chat-reactie eerst
  // gecontroleerd en won die: '!follow Iwein' matchte op de iwein-trigger, gaf true terug,
  // en handleCommand kreeg het bericht nooit te zien.
  if (message.startsWith('!')) return false;

  Logger.debug(`[CHAT] ${username}: ${message}`);

  for (const { pattern, reply } of REACTIONS) {
    const match = message.match(pattern);
    if (match) {
      reply(bot, username, match);
      return true;
    }
  }

  return false;
}

module.exports = { handleChatReactions };

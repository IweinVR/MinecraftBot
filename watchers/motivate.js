/**
 * GEHEIME easter egg — NIET in de README zetten, ook niet als er ooit een watcher-overzicht
 * wordt bijgewerkt. Dit mag een verrassing blijven voor wie de code niet leest.
 *
 * Zolang er iemand online is, stuurt de bot af en toe helemaal uit het niets een motiverend
 * berichtje naar een willekeurige speler, met naam en al. Geen commando, geen trigger — puur
 * toeval, en met opzet zeldzaam: gemiddeld zo'n twee uur tussen twee berichten, willekeurig
 * verdeeld tussen één en drie uur zodat het nooit als een klokje aanvoelt.
 */

const { Logger } = require('../utils');

const MIN_DELAY_MS = 60 * 60 * 1000;   // 1 uur
const MAX_DELAY_MS = 3 * 60 * 60 * 1000; // 3 uur, gemiddeld dus ~2 uur

const MESSAGES = [
  (naam) => `Hey ${naam}, gewoon even zeggen: je doet het geweldig. Ga zo door!`,
  (naam) => `${naam}, vergeet niet dat je een topper bent. Op naar de volgende diamant!`,
  (naam) => `Kleine reminder voor ${naam}: elke expert was ooit een beginner. Blijf bouwen!`,
  (naam) => `${naam}, je inventaris mag dan vol zooi zitten, maar jij bent geweldig bezig.`,
  (naam) => `Even een schouderklopje voor ${naam} — knap werk tot nu toe!`,
  (naam) => `${naam}, ook al graaf je soms recht naar beneden: je bent op de goede weg.`,
  (naam) => `Onthoud dit, ${naam}: creepers ontploffen, maar jouw motivatie niet. Keep going!`,
  (naam) => `${naam} — "It does not matter how slowly you go as long as you do not stop." — Confucius`,
  (naam) => `${naam} — "It always seems impossible until it's done." — Nelson Mandela`,
  (naam) => `${naam} — "Success is not final; failure is not fatal: it is the courage to continue that counts." — Winston S. Churchill`,
  (naam) => `${naam} — "Do what you can, with what you have, where you are." — Theodore Roosevelt`,
  (naam) => `${naam} — "Motivation gets attention. Discipline gets results."`,
  (naam) => `${naam} — "You will never always be motivated. You have to learn to be disciplined."`,
  (naam) => `${naam} — "The body achieves what the mind believes."`,
  (naam) => `${naam} — "Success is the sum of small efforts, repeated day in and day out."`,
];

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function pickRandomPlayer(bot) {
  const namen = Object.keys(bot.players).filter(naam => naam !== bot.username);
  if (namen.length === 0) return null;
  return namen[Math.floor(Math.random() * namen.length)];
}

function startMotivationWatcher(bot) {
  let timer = null;

  function schedule() {
    const delay = randomDelay();
    Logger.debug(`Easter egg: volgende motivatie-kans over ${Math.round(delay / 60000)} minuten`);
    timer = setTimeout(tick, delay);
  }

  function tick() {
    const naam = pickRandomPlayer(bot);
    // Niemand online? Dan gewoon opnieuw plannen, geen bericht overslaan-en-inhalen — anders
    // zou de bot bij het eerstvolgende inloggen meteen een bericht afvuren dat al "gepland" stond.
    if (naam) {
      const bericht = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      bot.chat(bericht(naam));
      Logger.debug(`Easter egg getriggerd voor ${naam}`);
    }
    schedule();
  }

  // setTimeout leeft los van de bot-verbinding: zonder deze opruiming blijft de timer van een
  // oude, losgekoppelde bot na een herverbinding gewoon doortikken en probeert hij op een dode
  // socket te chatten — en bij elke volgende reconnect komt daar nog zo'n spooktimer bij.
  bot.once('end', () => clearTimeout(timer));

  schedule();
}

module.exports = { startMotivationWatcher };

/**
 * Teleporteren op verzoek: !tp haalt de bot naar je toe.
 *
 * De bot heeft op deze server commandorechten, dus "kom hier" hoeft niet gelopen te worden.
 * /tp zet hem er in één keer neer, ook als je duizend blokken verderop staat, achter een
 * oceaan, of onder de grond waar de pathfinder toch nooit was gekomen. !kom blijft bestaan
 * voor als je hem juist wél wilt zien lopen.
 *
 * Drie dingen die hier niet toevallig zo staan:
 *
 *  1. Een servercommando geeft geen antwoord dat je kunt afwachten. Mag de bot /tp niet
 *     gebruiken, dan gebeurt er domweg niets. Daarom wordt er achteraf op het 'forcedMove'-
 *     event gewacht (dat is de server die de bot verplaatst) en nageteld hoe ver hij echt
 *     verschoven is. Zonder die check roept hij "ik ben er!" vanaf de andere kant van de
 *     wereld, en dat is precies het soort melding waar je in het spel niets aan hebt.
 *
 *  2. De naam gaat rechtstreeks een commando in dat met op-rechten draait. Alles wat geen
 *     gewone spelersnaam is wordt daarom geweigerd: met een selector als @a of
 *     @e[type=creeper] laat je de bot anders van alles verslepen namens de server.
 *
 *  3. Een lopend doel wordt gewist. Stond de bot te volgen of naar een coördinaat te lopen,
 *     dan wandelt hij na de sprong meteen weer terug en lijkt het alsof de teleport mislukt
 *     is. Een lopende TAAK (boeren, minen) wordt bewust niet afgebroken; die zegt hij er
 *     alleen bij, zodat je zelf kunt kiezen of je !stop typt.
 */

const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger } = require('../utils');

const TP = CONFIG.teleport;

// Minecraft-namen: letters, cijfers en underscores, hoogstens 16 tekens. Alles daarbuiten
// (spaties, @-selectors, ~ en ^ voor coördinaten) hoort niet in een commando van een op.
const SPELERSNAAM = /^[A-Za-z0-9_]{1,16}$/;

// Waar de bot mee bezig kan zijn als je hem wegteleporteert. Alleen om het te melden: de
// taak zelf loopt gewoon door en stuurt hem waarschijnlijk terug.
const BEZIG_MET = {
  isMining: 'graven',
  isFarming: 'boeren',
  isBreeding: 'fokken',
  isSorting: 'sorteren',
  isDumping: 'mijn tas legen',
  isTrading: 'handelen',
  isFishing: 'vissen',
  isFetching: 'iets halen',
  isGiving: 'iets geven',
  isSmithing: 'smeden',
};

function lopendeTaak() {
  for (const [vlag, naam] of Object.entries(BEZIG_MET)) {
    if (botState[vlag]) return naam;
  }
  return null;
}

/**
 * Wacht tot de server de bot verplaatst.
 *
 * 'forcedMove' is precies dat signaal: mineflayer vuurt het af zodra er een position_and_look
 * van de server binnenkomt. Dat is betrouwbaarder dan de positie pollen, want bij een sprong
 * naar een plek vlakbij (dezelfde kamer) is het verschil in coördinaten klein.
 */
function waitForForcedMove(bot, timeoutMs) {
  return new Promise(resolve => {
    let klaar = false;
    const afronden = (verplaatst) => {
      if (klaar) return;
      klaar = true;
      clearTimeout(timer);
      bot.removeListener('forcedMove', opMove);
      resolve(verplaatst);
    };
    const opMove = () => afronden(true);
    const timer = setTimeout(() => afronden(false), timeoutMs);
    bot.on('forcedMove', opMove);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Hoe ver staat de bot van deze speler af, als die tenminste in beeld is? */
function afstandTot(bot, naam) {
  const entity = bot.players?.[naam]?.entity;
  if (!entity?.position) return null;
  return bot.entity.position.distanceTo(entity.position);
}

/**
 * Teleporteert de bot naar een speler.
 *
 * @param {object} bot
 * @param {string} username wie het vroeg (krijgt het antwoord)
 * @param {string} [doel] naar wie hij moet; standaard naar de vrager zelf
 * @returns {Promise<boolean>} of de sprong gelukt is
 */
async function teleportToPlayer(bot, username, doel = username) {
  const naam = (doel ?? '').trim();

  if (!SPELERSNAAM.test(naam)) {
    bot.chat(`"${naam}" is geen spelersnaam die ik in een commando durf te zetten.`);
    Logger.warn(`!tp geweigerd: verdachte naam "${naam}" van ${username}`);
    return false;
  }

  if (naam.toLowerCase() === bot.username.toLowerCase()) {
    bot.chat('Naar mezelf teleporteren doe ik liever niet, daar sta ik al.');
    return false;
  }

  // Alleen als waarschuwing: de speler hoeft niet in beeld te zijn (dat is juist het nut van
  // /tp), maar staat hij niet eens op de server, dan doet het commando sowieso niets.
  if (!bot.players?.[naam]) {
    bot.chat(`Ik zie geen speler die ${naam} heet. Ik probeer het toch.`);
  }

  // Zonder dit loopt hij na de sprong meteen terug naar waar hij mee bezig was, en dan lijkt
  // het alsof de teleport niet gewerkt heeft.
  bot.pathfinder.setGoal(null);
  bot.pathfinder.stop();
  bot.clearControlStates();
  botState.lastGoal = null;
  botState.followToken = null;

  const vanaf = bot.entity.position.clone();
  const wachten = waitForForcedMove(bot, TP.timeout);

  Logger.info(`Teleport: /tp ${bot.username} ${naam} (gevraagd door ${username})`);
  bot.chat(`/tp ${bot.username} ${naam}`);

  const verplaatst = await wachten;
  // De server stuurt de nieuwe positie en de chunks eromheen net na elkaar; even wachten
  // scheelt een bot die in het niets hangt te vallen terwijl de wereld nog laadt.
  await sleep(TP.settleDelay);

  const gesprongen = bot.entity.position.distanceTo(vanaf);
  const bijSpeler = afstandTot(bot, naam);

  // Twee manieren waarop het tóch goed kan zijn gegaan zonder dat we het event zagen: de
  // sprong was groot genoeg om niet toevallig te zijn, of hij staat nu naast de speler.
  const gelukt = verplaatst || gesprongen >= TP.minDistance || (bijSpeler !== null && bijSpeler <= TP.arrivedDistance);

  if (!gelukt) {
    Logger.warn(`Teleport naar ${naam} gaf geen beweging (${gesprongen.toFixed(1)} blokken)`);
    bot.chat(`Dat lukt niet, ${username}. Mag ik /tp wel gebruiken op deze server? Anders kom ik lopend met !kom.`);
    return false;
  }

  Logger.info(`Teleport gelukt: ${gesprongen.toFixed(1)} blokken verplaatst`);
  bot.chat(naam === username ? `Hier ben ik, ${username}!` : `Ik sta bij ${naam}.`);

  const taak = lopendeTaak();
  if (taak) bot.chat(`Ik was trouwens nog met ${taak} bezig; typ !stop als ik daarmee moet ophouden.`);

  return true;
}

module.exports = {
  teleportToPlayer,
  // geëxporteerd voor tests en hergebruik
  SPELERSNAAM,
  lopendeTaak,
  waitForForcedMove,
};

/**
 * Creeper-alarm: waarschuwen in de chat en even uitloggen.
 *
 * Een creeper is het enige monster waar terugvechten averechts werkt — ernaartoe lopen is
 * precies wat hem laat ontploffen, en daarom staat hij ook in NO_FIGHT_MOBS. Wegrennen lukt
 * maar half, want hij loopt even hard als de bot. Wat wél altijd werkt is uitloggen: een
 * uitgelogde speler is geen doelwit meer, en in een leeg stuk wereld verdwijnt de creeper
 * vanzelf zodra de chunks uit beeld raken.
 *
 * De bot roept dus eerst om hulp met zijn coördinaten erbij, zegt dat hij zo terugkomt, en
 * verbindt daarna opnieuw. Dat laatste doet hij niet zelf: bot.quit() geeft 'end', en de
 * herverbind-logica in Index.js pakt het op. Via botState.reconnectDelay weet die dat het
 * deze keer een minuut moet duren in plaats van de gebruikelijke vijf seconden.
 */

const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger } = require('../utils');

const CREEPER = CONFIG.creeper;

// Blijft over een herverbinding heen bestaan (de module wordt maar één keer geladen): zo
// schiet de bot niet meteen na het inloggen opnieuw in paniek als de creeper er nog staat,
// en blijft hij niet in een lus van uitloggen-inloggen-uitloggen hangen.
let laatsteAlarm = 0;

function nearestCreeper(bot) {
  let dichtstbij = null;
  let kortste = Infinity;

  for (const entity of Object.values(bot.entities)) {
    // Kleine letters voor de zekerheid: entity.name is normaal 'creeper', maar een enkele
    // server/versie levert de naam met hoofdletter aan.
    if (!entity?.position || entity.name?.toLowerCase() !== 'creeper') continue;
    const afstand = bot.entity.position.distanceTo(entity.position);
    if (afstand > CREEPER.range || afstand >= kortste) continue;
    kortste = afstand;
    dichtstbij = entity;
  }

  return dichtstbij ? { entity: dichtstbij, afstand: kortste } : null;
}

function startCreeperWatcher(bot) {
  let alarmLoopt = false;
  let lastCheck = 0;
  let spawnedAt = 0;

  bot.once('spawn', () => { spawnedAt = Date.now(); });

  async function alarm(creeper, afstand) {
    alarmLoopt = true;
    laatsteAlarm = Date.now();

    const p = bot.entity.position;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const z = Math.round(p.z);
    Logger.warn(`Creeper op ${afstand.toFixed(1)} blokken, bot logt uit (${x} ${y} ${z})`);

    try {
      bot.chat(`Yo, creeper bij mij op ${x} ${y} ${z}! Kom die plz helpen wegdoen.`);
      // Even tussenruimte: twee berichten in dezelfde tick worden op sommige servers als
      // spam gezien, en dan komt het tweede er niet meer uit.
      await new Promise(resolve => setTimeout(resolve, CREEPER.chatGap));
      bot.chat(`Ik log heel even uit, ben over ${Math.round(CREEPER.awayMs / 1000)} seconden terug.`);
      await new Promise(resolve => setTimeout(resolve, CREEPER.chatGap));
    } catch (err) {
      Logger.debug(`Creeper-waarschuwing niet verstuurd: ${err.message}`);
    }

    // Index.js leest dit in scheduleReconnect() en wacht deze keer dus langer.
    botState.reconnectDelay = CREEPER.awayMs;
    bot.quit('creeper in de buurt');
  }

  bot.on('physicsTick', () => {
    if (alarmLoopt || !bot.entity) return;

    const now = Date.now();
    if (now - lastCheck < CREEPER.checkInterval) return;
    lastCheck = now;

    // Net ingelogd: eerst even rondkijken. Zonder deze pauze logt hij bij een creeper die
    // blijft staan meteen weer uit, en staat de chat vol met dezelfde waarschuwing.
    if (!spawnedAt || now - spawnedAt < CREEPER.graceMs) return;
    if (now - laatsteAlarm < CREEPER.cooldownMs) return;

    const gevaar = nearestCreeper(bot);
    if (!gevaar) return;

    alarm(gevaar.entity, gevaar.afstand).catch(err => Logger.error('Creeper-alarm ging mis', err));
  });

  Logger.info('Creeper-alarm actief (waarschuwt in de chat en logt even uit)');
}

module.exports = { startCreeperWatcher };

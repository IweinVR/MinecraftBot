/**
 * Creeper-verdediging: van veilige afstand beschieten, en als hij toch te dichtbij komt
 * waarschuwen in de chat en even uitloggen.
 *
 * Ernaartoe LOPEN om te vechten werkt averechts — dat is precies wat een creeper laat
 * ontploffen, en daarom staat hij ook in NO_FIGHT_MOBS. Een pijl afschieten hoeft daar niet
 * voor: dat kan van ruime afstand, ver buiten zijn ontploffingsbereik. Heeft de bot een boog
 * en pijlen bij zich, dan probeert hij een creeper tussen `range` en `shootRange` dus eerst
 * neer te schieten in plaats van meteen in paniek te raken.
 *
 * Komt hij ondanks dat toch binnen `range`, dan is wegrennen nog steeds geen optie (hij loopt
 * even hard als de bot). Wat wél altijd werkt is uitloggen: een uitgelogde speler is geen
 * doelwit meer, en in een leeg stuk wereld verdwijnt de creeper vanzelf zodra de chunks uit
 * beeld raken.
 *
 * De bot roept dus eerst om hulp met zijn coördinaten erbij, zegt dat hij zo terugkomt, en
 * verbindt daarna opnieuw. Dat laatste doet hij niet zelf: bot.quit() geeft 'end', en de
 * herverbind-logica in Index.js pakt het op. Via botState.reconnectDelay weet die dat het
 * deze keer een minuut moet duren in plaats van de gebruikelijke vijf seconden.
 */

const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger, findItem } = require('../utils');

const CREEPER = CONFIG.creeper;

// Blijft over een herverbinding heen bestaan (de module wordt maar één keer geladen): zo
// schiet de bot niet meteen na het inloggen opnieuw in paniek als de creeper er nog staat,
// en blijft hij niet in een lus van uitloggen-inloggen-uitloggen hangen.
let laatsteAlarm = 0;

function nearestCreeper(bot, maxRange = CREEPER.range) {
  let dichtstbij = null;
  let kortste = Infinity;

  for (const entity of Object.values(bot.entities)) {
    // Kleine letters voor de zekerheid: entity.name is normaal 'creeper', maar een enkele
    // server/versie levert de naam met hoofdletter aan.
    if (!entity?.position || entity.name?.toLowerCase() !== 'creeper') continue;
    const afstand = bot.entity.position.distanceTo(entity.position);
    if (afstand > maxRange || afstand >= kortste) continue;
    kortste = afstand;
    dichtstbij = entity;
  }

  return dichtstbij ? { entity: dichtstbij, afstand: kortste } : null;
}

/** Heeft ze een boog én pijlen bij zich? Zonder pijlen heeft de boog equippen geen zin. */
function heeftBoogEnPijl(bot) {
  return Boolean(findItem(bot, 'bow') && findItem(bot, 'arrow'));
}

/**
 * Boog trekken, op de creeper mikken en lossen. Eén pijl per aanroep — komt hij nog dichterbij
 * of is hij dood, dan stopt de tick-lus vanzelf met opnieuw aanroepen.
 */
async function shootCreeper(bot, creeper) {
  try {
    const boog = findItem(bot, 'bow');
    if (!boog || !findItem(bot, 'arrow') || !creeper.isValid) return;

    await bot.equip(boog, 'hand');
    if (!creeper.isValid) return; // kan tijdens het equippen alsnog verdwenen zijn

    await bot.lookAt(creeper.position.offset(0, (creeper.height ?? 1.7) / 2, 0));
    bot.activateItem();
    await new Promise(resolve => setTimeout(resolve, CREEPER.drawTimeMs));
    bot.deactivateItem();

    Logger.debug(`Pijl afgeschoten op creeper op ${creeper.position.floored()}`);
  } catch (err) {
    Logger.debug(`Boogschot op creeper mislukt: ${err.message}`);
  }
}

function startCreeperWatcher(bot) {
  let alarmLoopt = false;
  let schietBezig = false;
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

    // Breder zoeken dan het paniekbereik: een creeper tussen range en shootRange is nog
    // veilig, en dat is precies de zone waarin schieten zin heeft.
    const gevaar = nearestCreeper(bot, CREEPER.shootRange);
    if (!gevaar) return;

    if (gevaar.afstand <= CREEPER.range) {
      if (now - laatsteAlarm < CREEPER.cooldownMs) return;
      alarm(gevaar.entity, gevaar.afstand).catch(err => Logger.error('Creeper-alarm ging mis', err));
      return;
    }

    // Nog op veilige afstand: eerst proberen 'm neer te schieten voor hij dichterbij sluipt.
    // Niet doen tijdens een gevecht/vlucht/zelfmoord elders — dan wisselt bot.equip() net
    // op het verkeerde moment het wapen dat die andere actie nodig heeft.
    if (!schietBezig && heeftBoogEnPijl(bot)
        && !botState.isFighting && !botState.isFleeing && !botState.isSuiciding) {
      schietBezig = true;
      shootCreeper(bot, gevaar.entity)
        .catch(err => Logger.debug(`Creeper-boogschot ging mis: ${err.message}`))
        .finally(() => { schietBezig = false; });
    }
  });

  Logger.info('Creeper-verdediging actief (schiet van afstand, waarschuwt en logt uit als hij te dichtbij komt)');
}

module.exports = { startCreeperWatcher };

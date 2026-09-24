/**
 * Alle chatcommando's. Wordt aangeroepen vanuit de chat-handler in Index.js, maar pas nadat
 * features/chat.js het bericht heeft laten passeren (die pakt gewone praatjes af, en laat
 * alles wat met ! begint met rust).
 *
 * Opbouw: eerst het object 'commands' met de commando's zonder argumenten, daarna een reeks
 * regex-matches voor de commando's mét argumenten. Wie een commando toevoegt zet het bij de
 * juiste helft en vermeldt het in !help.
 *
 * Let op bij de tunnelcommando's: de kijkrichting is als primaire invoer vervangen door een
 * doelpunt, omdat yaw op vier windrichtingen wordt afgerond en dus niet altijd kiest wat je
 * bedoelde. '!tunnel hier' bestaat nog wel, maar zegt er nu bij welke richting hij koos.
 *
 * De oude tunnelvormen onderaan hebben een andere argumentvolgorde dan de nieuwe. Dat is
 * geen typfout maar achterwaartse compatibiliteit.
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG, DIRECTIONS } = require('../config');
const botState = require('../state');
const { Logger, floorPos, getInventoryStatus, setMovements, findNearbyBlocks, abortAllTasks } = require('../utils');
const { mineTunnel, mineCorridor } = require('./mining');

const { setBedSpawn, killBot } = require('./combat');
const { farmCrops, stopFarming } = require('./farming');
const { findCropGroup, CROP_LABELS } = require('../data/crops');
const { breedOnce } = require('./breeding');
const { sortItems, stopSorting } = require('./sorting');
const { tradeCrops, stopTrading } = require('./trading');
const { fishForItems, stopFishing } = require('./fishing');
const { fetchItem, giveItem, stopGiving, whereIs, refreshIndex, forgetIndex, stopFetching } = require('./courier');
const { resupplyTools, craftItem, stopSmithing } = require('./toolsmith');

// Nederlandse windrichtingen mogen ook; intern blijft alles Engels omdat DIRECTIONS dat is.
const COMPASS = {
  noord: 'north', zuid: 'south', oost: 'east', west: 'west',
  north: 'north', south: 'south', east: 'east',
};

// Terug naar het Nederlands voor wat de bot in de chat zegt.
const COMPASS_NL = { north: 'noord', south: 'zuid', east: 'oost', west: 'west' };

// Simpel naar een doel toe lopen zonder pathfinder (en dus zonder blokken te plaatsen).
async function walkToTarget(bot, target, maxDistance = 50, maxSteps = 400) {
  try {
    for (let step = 0; step < maxSteps; step++) {
      const distance = bot.entity.position.distanceTo(target.position);
      if (distance <= 1.5) return true;
      if (distance > maxDistance) {
        Logger.warn(`Target too far: ${distance.toFixed(1)}m`);
        return false;
      }

      await bot.lookAt(target.position);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await new Promise(resolve => setTimeout(resolve, 150));
      bot.setControlState('jump', false);
    }
    // Zonder deze stap-limiet bleef dit eeuwig doorlopen zodra de bot vastliep zonder
    // dichterbij of verder weg te komen.
    Logger.warn('walkToTarget: maximaal aantal stappen bereikt');
    return false;
  } finally {
    // Ook op de faal-paden moeten de controls los, anders blijft de bot vooruit rennen.
    bot.clearControlStates();
  }
}

// mineflayer rekent yaw als atan2(-dx, -dz): yaw 0 = noord (-z), pi/2 = west (-x),
// +/-pi = zuid (+z), -pi/2 = oost (+x). Noord en zuid stonden hier omgedraaid, waardoor
// "!tunnel hier 20" precies de verkeerde kant op groef.
function getDirectionFromYaw(yaw) {
  let normalized = yaw % (2 * Math.PI);
  if (normalized > Math.PI) normalized -= 2 * Math.PI;
  if (normalized < -Math.PI) normalized += 2 * Math.PI;

  if (normalized >= -Math.PI / 4 && normalized < Math.PI / 4) return 'north';
  if (normalized >= Math.PI / 4 && normalized < 3 * Math.PI / 4) return 'west';
  if (normalized >= 3 * Math.PI / 4 || normalized < -3 * Math.PI / 4) return 'south';
  return 'east';
}

function getPlayerEntity(bot, username) {
  return bot.players[username]?.entity ?? null;
}

// mineTunnel() draait los van het chat-event; zonder deze wrapper wordt een fout erin
// een unhandled promise rejection (en in moderne Node een harde crash).
function startTunnel(bot, ...args) {
  mineTunnel(bot, ...args).catch(err => {
    Logger.error('Tunnel error', err);
    bot.chat('Er ging iets mis met de tunnel.');
  });
}

function startCorridor(bot, from, to, opts) {
  mineCorridor(bot, from, to, opts).catch(err => {
    Logger.error('Tunnel error', err);
    bot.chat('Er ging iets mis met de tunnel.');
  });
}

function handleCommand(bot, username, message) {
  const commands = {
    '!kom': async () => {
      bot.pathfinder.stop();
      bot.clearControlStates();
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });

      const player = bot.players[username];
      if (!player) {
        bot.chat(`Ik zie je niet in het spel, ${username}!`);
        Logger.debug(`!kom: speler ${username} niet in bot.players`);
        return;
      }

      let target = null;
      for (let i = 0; i < 20; i++) {
        target = getPlayerEntity(bot, username);
        if (target) break;
        if (i < 5) Logger.debug(`!kom: wacht op entity... attempt ${i + 1}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (!target) {
        bot.chat(`Je bent te ver weg, ${username}! Kom wat dichter bij.`);
        Logger.warn(`!kom: ${username} is buiten zichtbereik na 20 pogingen`);
        return;
      }

      const pos = floorPos(target.position);
      botState.lastGoal = { type: 'goto', ...pos };
      botState.shouldRestore = true;

      bot.chat(`Ik kom er aan, ${username}!`);
      Logger.info(`!kom: ga naar ${username} op ${pos.x} ${pos.y} ${pos.z}`);

      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
        bot.chat('Ik ben bij je!');
      } catch (err) {
        Logger.warn(`!kom stuck/failed: ${err.message}`);
        bot.chat('Kan niet bij je komen...');
      } finally {
        bot.clearControlStates();
        setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
      }
    },

    '!komallow': async () => {
      bot.pathfinder.stop();
      bot.clearControlStates();

      let target = null;
      for (let i = 0; i < 20; i++) {
        target = getPlayerEntity(bot, username);
        if (target) break;
        if (i < 5) Logger.debug(`!komallow: wacht op entity... attempt ${i + 1}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (!target) {
        bot.chat(`Je bent te ver weg, ${username}! Kom wat dichter bij.`);
        Logger.warn(`!komallow: ${username} is buiten zichtbereik na 20 pogingen`);
        return;
      }

      const pos = floorPos(target.position);
      botState.lastGoal = { type: 'goto', ...pos };
      botState.shouldRestore = true;

      bot.chat(`Ik kom er aan (mag blokken breken), ${username}!`);
      Logger.info(`!komallow: ga naar ${username} op ${pos.x} ${pos.y} ${pos.z}`);

      setMovements(bot, { canDig: true, canPlace: false, allowSprinting: true }); // 'allow' = mag graven, niet bouwen
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
        bot.chat('Ik ben bij je!');
      } catch (err) {
        Logger.warn(`!komallow stuck/failed: ${err.message}`);
        bot.chat('Kan niet bij je komen...');
      } finally {
        // Stond eerder in beide takken los; in een finally kan het niet meer overgeslagen
        // worden als er iets anders dan een goto-fout misgaat.
        bot.clearControlStates();
        setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
      }
    },

    '!stop': () => {
      // Vlaggen eerst: de lopende lussen pollen hierop en breken hun huidige dig/goto af.
      // abortAllTasks() zet ook elke isX op false — zonder dat bleef een taak die vastliep
      // (of die met de bot mee was doodgegaan) voor altijd "ik ben al bezig" antwoorden.
      botState.shouldRestore = false;
      botState.lastGoal = null;
      botState.followToken = null;
      botState.lastMineData = null;
      abortAllTasks();

      // En dan meteen alles fysiek afkappen. stopDigging() ontbrak: zonder dat bleef een
      // lopende dig gewoon doorgaan tot het blok kapot was, dus "!stop" voelde traag.
      try { bot.stopDigging(); } catch (err) { /* was niet aan het graven */ }
      try { bot.pvp?.forceStop(); } catch (err) { /* was niet aan het vechten */ }
      bot.pathfinder.setGoal(null);
      bot.pathfinder.stop();
      bot.clearControlStates();

      bot.chat('Oke, ik stop METEEN.');
    },

    '!pos': () => {
      const p = floorPos(bot.entity.position);
      const status = getInventoryStatus(bot);
      bot.chat(`Ik sta op ${p.x} ${p.y} ${p.z}${status}`);
    },

    '!bed': () => setBedSpawn(bot),
    '!die': () => killBot(bot),
    '!farm': () => farmCrops(bot),
    '!stopfarm': () => stopFarming(bot),
    '!breed': () => breedOnce(bot),
    '!sort': () => sortItems(bot),
    '!stopsort': () => stopSorting(bot),
    '!trade': () => tradeCrops(bot),
    '!stoptrade': () => stopTrading(bot),
    '!vis': () => fishForItems(bot),
    '!stopvis': () => stopFishing(bot),
    '!index': () => refreshIndex(bot),
    '!vergeet': () => forgetIndex(bot),
    '!stophaal': () => stopFetching(bot),
    '!stopgeven': () => stopGiving(bot),
    '!gereedschap': () => resupplyTools(bot),
    '!stopmaak': () => stopSmithing(bot),

    '!help': () => {
      bot.chat('Navigatie: !kom | !komallow | !goto x y z | !gotoallow x y z | !follow @speler');
      bot.chat('Overig: !stop | !pos | !bed | !die | !stopmine | !collect blok aantal');
      bot.chat('Tunnel: !tunnel naar x y z | !tunnel naar mij | !tunnel noord 20');
      bot.chat('  grootte: zet "breedte hoogte" achter ELKE tunnelvorm, bv. !tunnel noord 20 3 3 (standaard is 1 breed, 2 hoog)');
      bot.chat('Boeren: !farm (alles: graan, meloen/pompoen, bessen, riet/bamboe, fungi) | !stopfarm');
      bot.chat('  één gewas: !farm tarwe | !farm wortels | !farm pompoen | !farm suikerriet (hij maakt dat gewas eerst helemaal af)');
      bot.chat('Fokken: !breed (voert koeien, schapen, varkens, kippen... met het juiste voer)');
      bot.chat('Sorteren: !sort | !sort x y z (invoerkist) | !stopsort');
      bot.chat('Handelen: !trade | !trade kist x y z hal x y z [kluis x y z] | !stoptrade');
      bot.chat('Vissen: !vis | !vis 20 (aantal worpen) | !stopvis');
      bot.chat('Koerier: !haal 64 cobblestone | !haal diamond | !waar ijzer | !index | !vergeet (lijst wissen) | !stophaal');
      bot.chat('  iets van haarzelf: !geef pickaxe | !geef 32 cobblestone (uit haar eigen inventaris) | !stopgeven');
      bot.chat('Smid: !gereedschap (aanvullen+repareren) | !maak diamond_pickaxe | !maak 8 torch');
    },

    '!stopmine': () => {
      botState.isMining = false;
      botState.stopMining = true;
      try { bot.stopDigging(); } catch (err) { /* was niet aan het graven */ }
      bot.pathfinder.setGoal(null);
      bot.pathfinder.stop();
      bot.chat('Mining gestopt!');
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    },
  };

  // hasOwnProperty i.p.v. een kale lookup: een speler die letterlijk "__proto__" of
  // "constructor" in de chat typt, kreeg anders een object van de prototypeketen terug
  // en liet de bot crashen op "is not a function".
  if (Object.prototype.hasOwnProperty.call(commands, message)) {
    Promise.resolve()
      .then(() => commands[message]())
      .catch(err => Logger.error(`Commando ${message} faalde`, err));
    return;
  }

  let match;

  match = message.match(/^!goto (-?\d+) (-?\d+) (-?\d+)$/);
  if (match) {
    const [, x, y, z] = match.map(Number);
    bot.pathfinder.stop();
    bot.clearControlStates();
    setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    setTimeout(() => {
      bot.chat(`Oke ${username}, ik ga naar ${x} ${y} ${z}!`);
      botState.lastGoal = { type: 'goto', x, y, z };
      botState.shouldRestore = true;
      bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
    }, 150);
    return;
  }

  match = message.match(/^!gotoallow (-?\d+) (-?\d+) (-?\d+)$/);
  if (match) {
    const [, x, y, z] = match.map(Number);
    bot.pathfinder.stop();
    bot.clearControlStates();
    setMovements(bot, { canDig: true, canPlace: false, allowSprinting: true }); // 'allow' = mag graven, niet bouwen
    setTimeout(() => {
      bot.chat(`Oke ${username}, ik ga naar ${x} ${y} ${z} (mag blokken breken)!`);
      botState.lastGoal = { type: 'goto', x, y, z };
      botState.shouldRestore = true;
      bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
    }, 150);
    return;
  }

  // !sort x y z -> die kist is de invoerbak, i.p.v. de dichtstbijzijnde koperen kist
  match = message.match(/^!sort (-?\d+) (-?\d+) (-?\d+)$/);
  if (match) {
    const [, x, y, z] = match.map(Number);
    sortItems(bot, { x, y, z }).catch(err => {
      Logger.error('Sorteerfout', err);
      bot.chat('Er ging iets mis met sorteren.');
    });
    return;
  }

  // !maak <aantal> <item>  en  !maak <item>
  match = message.match(/^!maak (?:(\d+) )?(.+)$/i);
  if (match) {
    const aantal = match[1] ? Number(match[1]) : 1;
    const naam = match[2].trim().toLowerCase().replace(/\s+/g, '_');
    craftItem(bot, naam, aantal).catch(err => {
      Logger.error('Smidsfout', err);
      bot.chat('Er ging iets mis met maken.');
    });
    return;
  }

  // !haal <aantal> <item>  en  !haal <item>  (standaard een hele stapel)
  match = message.match(/^!haal (?:(\d+) )?(.+)$/i);
  if (match) {
    const aantal = match[1] ? Number(match[1]) : null;
    fetchItem(bot, username, match[2].trim(), aantal).catch(err => {
      Logger.error('Koeriersfout', err);
      bot.chat('Er ging iets mis met halen.');
    });
    return;
  }

  // !geef <aantal> <item>  en  !geef <item>  (standaard alles wat ze ervan bij zich heeft)
  // Het verschil met !haal: dit haalt niets uit een kist, maar geeft iets weg dat ze nu al
  // in haar eigen inventaris heeft, zoals gereedschap of net geminede blokken.
  match = message.match(/^!geef (?:(\d+) )?(.+)$/i);
  if (match) {
    const aantal = match[1] ? Number(match[1]) : null;
    giveItem(bot, username, match[2].trim(), aantal).catch(err => {
      Logger.error('Geeffout', err);
      bot.chat('Er ging iets mis met geven.');
    });
    return;
  }

  // !farm <gewas> -> alleen dat ene gewas oogsten, bv. "!farm tarwe" of "!farm sugar cane".
  match = message.match(/^!farm (.+)$/i);
  if (match) {
    const arg = match[1].trim();
    // "!farm alles" is gewoon de gewone ronde; blocks=null betekent geen filter.
    const gewas = /^(alles|all)$/i.test(arg) ? { blocks: null, label: null } : findCropGroup(arg);
    if (!gewas) {
      bot.chat(`Ik ken "${arg}" niet als gewas.`);
      bot.chat(`Wel: ${CROP_LABELS.slice(0, 11).join(', ')} (en nog een paar).`);
      return;
    }
    farmCrops(bot, { only: gewas.blocks, label: gewas.label }).catch(err => {
      Logger.error('Farmfout', err);
      bot.chat('Er ging iets mis met het boeren.');
    });
    return;
  }

  // !waar <item> -> alleen opzoeken, niet lopen
  match = message.match(/^!waar (.+)$/i);
  if (match) {
    whereIs(bot, match[1].trim());
    return;
  }

  // !vis <aantal worpen>
  match = message.match(/^!vis (\d+)$/);
  if (match) {
    fishForItems(bot, Number(match[1])).catch(err => {
      Logger.error('Visfout', err);
      bot.chat('Er ging iets mis met vissen.');
    });
    return;
  }

  // !trade kist x y z hal x y z [kluis x y z]
  // Alle drie de plekken los opgeven, want een handelshal staat zelden naast je akker.
  match = message.match(/^!trade kist (-?\d+) (-?\d+) (-?\d+) hal (-?\d+) (-?\d+) (-?\d+)(?: kluis (-?\d+) (-?\d+) (-?\d+))?$/);
  if (match) {
    const g = match.slice(1).map(v => (v === undefined ? undefined : Number(v)));
    const opties = {
      cropChest: { x: g[0], y: g[1], z: g[2] },
      hall: { x: g[3], y: g[4], z: g[5] },
    };
    if (g[6] !== undefined) opties.vault = { x: g[6], y: g[7], z: g[8] };
    tradeCrops(bot, opties).catch(err => {
      Logger.error('Handelsfout', err);
      bot.chat('Er ging iets mis met handelen.');
    });
    return;
  }

  // ---------------------------------------------------------------- TUNNEL
  // De kijkrichting is als primaire invoer vervangen door een doelpunt. Reden: yaw wordt
  // op vier windrichtingen afgerond, en kijk je schuin (of net over een grens), dan kiest
  // hij een richting die niet voelt als wat je bedoelde. Een coördinaat of "naar mij" is
  // eenduidig: daar valt niets aan af te ronden.

  // !tunnel naar mij [breedte hoogte]  -> van de bot naar de speler
  match = message.match(/^!tunnel naar (?:mij|me|jou)(?: (\d+) (\d+))?$/i);
  if (match) {
    const target = getPlayerEntity(bot, username);
    if (!target) {
      bot.chat('Kan jouw positie niet vinden!');
      return;
    }
    const breedte = match[1] ? Number(match[1]) : 1;
    const hoogte = match[2] ? Number(match[2]) : 2;
    const to = floorPos(target.position);
    botState.shouldRestore = true;
    startCorridor(bot, bot.entity.position.floored(), new Vec3(to.x, to.y, to.z),
      { breedte, hoogte, label: `naar ${username}` });
    return;
  }

  // !tunnel naar x y z [breedte hoogte]  -> van de bot naar dat punt
  match = message.match(/^!tunnel naar (-?\d+) (-?\d+) (-?\d+)(?: (\d+) (\d+))?$/i);
  if (match) {
    const [, x, y, z, b, h] = match;
    const breedte = b ? Number(b) : 1;
    const hoogte = h ? Number(h) : 2;
    botState.shouldRestore = true;
    startCorridor(bot, bot.entity.position.floored(), new Vec3(Number(x), Number(y), Number(z)),
      { breedte, hoogte, label: `naar ${x} ${y} ${z}` });
    return;
  }

  // !tunnel vanaf x y z naar x y z [breedte hoogte]  -> volledig expliciet
  match = message.match(/^!tunnel vanaf (-?\d+) (-?\d+) (-?\d+) naar (-?\d+) (-?\d+) (-?\d+)(?: (\d+) (\d+))?$/i);
  if (match) {
    const [, fx, fy, fz, tx, ty, tz, b, h] = match;
    const breedte = b ? Number(b) : 1;
    const hoogte = h ? Number(h) : 2;
    botState.shouldRestore = true;
    startCorridor(bot, new Vec3(Number(fx), Number(fy), Number(fz)), new Vec3(Number(tx), Number(ty), Number(tz)),
      { breedte, hoogte, label: `van ${fx} ${fy} ${fz} naar ${tx} ${ty} ${tz}` });
    return;
  }

  // !tunnel <richting> <lengte> [breedte hoogte]  -> expliciete windrichting, nl of en
  match = message.match(/^!tunnel (noord|zuid|oost|west|north|south|east|west) (\d+)(?: (\d+) (\d+))?$/i);
  if (match) {
    const [, woord, lengte, b, h] = match;
    const richting = COMPASS[woord.toLowerCase()];
    const breedte = b ? Number(b) : 1;
    const hoogte = h ? Number(h) : 2;
    botState.shouldRestore = true;
    // Eén blok vooruit beginnen: anders is de eerste cel het blok waar de bot zelf in staat
    // en lijkt de tunnel een blok korter dan gevraagd.
    const dir = DIRECTIONS[richting];
    const start = bot.entity.position.floored().offset(dir.x, 0, dir.z);
    startCorridor(bot, start, start.offset(dir.x * (Number(lengte) - 1), 0, dir.z * (Number(lengte) - 1)),
      { breedte, hoogte, label: `${lengte} blokken naar het ${COMPASS_NL[richting]}` });
    return;
  }

  // Oude vormen blijven werken.
  match = message.match(/^!tunnel (\d+) (\d+) (\d+) (north|south|east|west)$/);
  if (match) {
    const [, diepte, breedte, hoogte, richting] = match;
    const target = getPlayerEntity(bot, username);
    if (!target) {
      bot.chat('Kan jouw positie niet vinden!');
      return;
    }
    const pos = floorPos(target.position);
    botState.shouldRestore = true;
    startTunnel(bot, pos.x, pos.y, pos.z, richting, Number(diepte), Number(hoogte), Number(breedte));
    return;
  }

  match = message.match(/^!tunnel (-?\d+) (-?\d+) (-?\d+) (north|south|east|west) (\d+) (\d+) (\d+)$/);
  if (match) {
    const [, x, y, z, richting, diepte, hoogte, breedte] = match;
    botState.shouldRestore = true;
    startTunnel(bot, Number(x), Number(y), Number(z), richting, Number(diepte), Number(hoogte), Number(breedte));
    return;
  }

  // !tunnel hier <lengte> gebruikt nog wel de kijkrichting, maar zegt er nu bij welke
  // richting hij gekozen heeft, zodat je meteen ziet of dat klopte.
  match = message.match(/^!tunnel hier (?:(noord|zuid|oost|west|north|south|east|west) )?(\d+)(?: (\d+) (\d+))?$/i);
  if (match) {
    const [, woord, lengte, b, h] = match;
    const target = getPlayerEntity(bot, username);
    if (!target) {
      bot.chat('Kan jouw positie niet vinden!');
      return;
    }
    const richting = woord ? COMPASS[woord.toLowerCase()] : getDirectionFromYaw(target.yaw);
    if (!woord) bot.chat(`Je kijkt naar het ${COMPASS_NL[richting]}. Klopt dat niet? Gebruik "!tunnel naar x y z".`);
    const breedte = b ? Number(b) : 1;
    const hoogte = h ? Number(h) : 2;
    const dir = DIRECTIONS[richting];
    const pos = floorPos(target.position);
    const start = new Vec3(pos.x, pos.y, pos.z).offset(dir.x, 0, dir.z);
    botState.shouldRestore = true;
    startCorridor(bot, start, start.offset(dir.x * (Number(lengte) - 1), 0, dir.z * (Number(lengte) - 1)),
      { breedte, hoogte, label: `${lengte} blokken naar het ${COMPASS_NL[richting]}` });
    return;
  }

  match = message.match(/^!collect (\w+) (\d+)$/);
  if (match) {
    const [, blockName, amountStr] = match;
    const amount = parseInt(amountStr, 10);

    const blocks = findNearbyBlocks(bot, blockName, amount);
    if (blocks.length === 0) {
      bot.chat(`Geen ${blockName} gevonden in de buurt!`);
      return;
    }

    bot.chat(`Verzamel ${blocks.length}x ${blockName}...`);
    setMovements(bot, { canDig: true, canPlace: false, allowSprinting: true });

    bot.collectBlock.collect(blocks, (err) => {
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
      if (err) {
        Logger.warn(`Collect error: ${err.message}`);
        bot.chat('Kon niet alles verzamelen.');
      } else {
        bot.chat(`Klaar met verzamelen van ${blockName}!`);
      }
    });
    return;
  }

  match = message.match(/^!follow (.+)$/);
  if (match) {
    const targetName = match[1].trim().replace('@', '');
    if (!getPlayerEntity(bot, targetName)) {
      bot.chat(`Ik zie ${targetName} niet!`);
      return;
    }
    bot.chat(`Ik volg ${targetName} nu!`);

    // Elke !follow krijgt een eigen token. Zonder dit bleef bij een tweede !follow op
    // dezelfde speler de oude timer-lus ook doorlopen, en die stapelden op.
    const followToken = Symbol('follow');
    botState.followToken = followToken;
    botState.lastGoal = { type: 'follow', username: targetName };
    botState.shouldRestore = true;

    const updateFollow = () => {
      if (botState.followToken !== followToken) return;
      if (botState.lastGoal?.type !== 'follow' || botState.lastGoal.username !== targetName) return;

      const currentTarget = getPlayerEntity(bot, targetName);
      if (currentTarget) {
        try {
          bot.pathfinder.setGoal(new goals.GoalFollow(currentTarget, CONFIG.pathfinding.followDistance), true);
        } catch (err) {
          Logger.debug(`Follow ${targetName} error: ${err.message}`);
        }
      }
      setTimeout(updateFollow, 1000);
    };

    updateFollow();
    return;
  }
}

module.exports = { handleCommand, getDirectionFromYaw, walkToTarget };

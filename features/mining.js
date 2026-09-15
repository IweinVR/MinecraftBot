/**
 * Tunnels graven.
 *
 * mineCorridor(from, to) is de kern: het rekent een pad van blokken uit tussen twee punten
 * en graaft dat cel voor cel vrij. mineTunnel(...) is alleen nog een wikkel die uit een
 * richting + diepte een eindpunt maakt, voor de oude commandovormen.
 *
 * Het belangrijkste ontwerpbesluit: tijdens het graven staat de pathfinder op canDig=false.
 * Alleen deze module graaft. Stond hij op true (zoals eerst), dan rekende A* zijn eigen route
 * naar elk blok uit en groef de bot dwars door wanden, over de tunnel heen en terug — vandaar
 * de losse gaten naast de gang. De bot loopt nu door de gang die hij zelf al vrijgemaakt heeft.
 *
 * Andere dingen die hier niet toevallig zo staan:
 *   - per cel van BOVEN naar beneden graven, anders staat de bot in een gat met steen op ooghoogte
 *   - corridorCells() beweegt per stap één as, zodat er een trap ontstaat waar je door kunt
 *   - grind en zand vallen na het graven alsnog in de gang; die worden opnieuw weggehaald
 *   - lastMineData onthoudt bij welke cel hij was, zodat een respawn verdergaat i.p.v. opnieuw
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG, DIRECTIONS, SIDE_DIRECTIONS, CHEST_BLOCKS } = require('../config');
const botState = require('../state');
const { Logger, setMovements, findItem, findItemExact, isItemToKeep, findNearestBlock, placeBlockAllowed, abortable } = require('../utils');

// Volgorde is belangrijk: de specifiekste sleutels staan bovenaan, zodat 'cobblestone'
// niet door de bredere 'stone'-regel wordt opgeslokt.
const TOOL_PREFERENCES = {
  'ore': ['pickaxe'],
  'cobblestone': ['pickaxe'],
  'grass_block': ['shovel', 'pickaxe'],
  'dirt': ['shovel', 'pickaxe'],
  'sand': ['shovel'],
  'gravel': ['shovel', 'pickaxe'],
  'log': ['axe'],
  'planks': ['axe'],
  'stone': ['pickaxe'],
};

const DEFAULT_TOOLS = ['pickaxe', 'axe', 'shovel'];

function getBestTool(bot, blockName) {
  for (const keyword of Object.keys(TOOL_PREFERENCES)) {
    if (blockName.includes(keyword)) {
      return TOOL_PREFERENCES[keyword];
    }
  }
  return DEFAULT_TOOLS;
}

// Blokken die vallen zodra het blok eronder weg is. Die vullen het gat dat we net gegraven
// hebben weer op, en omdat de lus intussen al doorliep bleven ze staan.
const FALLING_BLOCKS = new Set([
  'gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'pointed_dripstone',
]);

function isFallingBlock(name) {
  return FALLING_BLOCKS.has(name) || name.endsWith('_concrete_powder');
}

// bot.dig() kent in mineflayer 4 geen callback meer (alleen (block, forceLook, digFace) -> Promise).
// Deze wrapper zorgt dat een dig die blijft hangen na een timeout gewoon doorgaat, i.p.v. de
// hele mining-loop te blokkeren. shouldStop() laat !stop een lopende dig meteen afkappen
// in plaats van tot het einde te moeten wachten.
async function safeDig(bot, block, timeoutMs = 15000, shouldStop = null) {
  let timer;
  let poller;
  try {
    const racers = [
      bot.dig(block),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Dig timeout')), timeoutMs);
      }),
    ];

    if (shouldStop) {
      racers.push(new Promise((_, reject) => {
        poller = setInterval(() => {
          if (!shouldStop()) return;
          clearInterval(poller);
          try { bot.stopDigging(); } catch (err) { /* niets aan het graven */ }
          reject(new Error('Graven afgebroken'));
        }, 100);
      }));
    }

    await Promise.race(racers);
    return true;
  } catch (err) {
    Logger.debug(`Dig mislukt: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
    clearInterval(poller);
  }
}

/**
 * Graaft weg wat er ná het graven in het gat valt (grind, zand, betonpoeder).
 *
 * Het oude gedrag: de bot groef een blok weg, de lus ging naar de volgende positie, en het
 * grind dat daarna naar beneden kwam bleef gewoon in de tunnel liggen — het blok dat er
 * volgens de lus stond, was immers al gemined.
 */
async function digFallingBlocks(bot, pos, shouldStop) {
  let extra = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (shouldStop()) break;
    // Even wachten: het blok moet eerst als entity vallen en weer als blok landen.
    await new Promise(resolve => setTimeout(resolve, 150));
    const block = bot.blockAt(pos);
    if (!block || !isFallingBlock(block.name)) break;
    Logger.debug(`Gevallen ${block.name} op ${pos} wordt alsnog weggehaald`);
    await equipBestTool(bot, block.name);
    if (!await safeDig(bot, block, 15000, shouldStop)) break;
    extra++;
  }
  return extra;
}

async function equipBestTool(bot, blockName) {
  const toolNames = getBestTool(bot, blockName);
  for (const toolName of toolNames) {
    const tool = findItem(bot, toolName);
    if (tool) {
      try {
        await bot.equip(tool, 'hand');
        return true;
      } catch (err) {
        Logger.debug(`Kon ${toolName} niet equippen: ${err.message}`);
      }
    }
  }
  return false;
}

// Een fakkel hoort bij voorkeur op de GROND. SIDE_DIRECTIONS bevatte alleen de vier
// zijkanten, dus in een tunnel waar de wanden net weggegraven waren, was er geen enkel
// vlak om de fakkel tegenaan te zetten en werd er simpelweg nooit een geplaatst.
const TORCH_DIRECTIONS = [{ x: 0, y: -1, z: 0 }, ...SIDE_DIRECTIONS];

async function placeBlock(bot, itemNames, targetX, targetY, targetZ, directions = SIDE_DIRECTIONS, exact = false) {
  const item = exact ? findItemExact(bot, itemNames) : findItem(bot, itemNames);
  if (!item) {
    Logger.debug(`Niets om te plaatsen (gezocht: ${Array.isArray(itemNames) ? itemNames.join('/') : itemNames})`);
    return false;
  }

  for (const dir of directions) {
    // bot.blockAt() gaat via prismarine-world, dat pos.floored() aanroept. Een plain
    // {x,y,z}-object heeft die methode niet, dus dit MOET een Vec3 zijn — anders gooide
    // elke plaatsing een TypeError en werd er nooit een fakkel of kist geplaatst.
    const checkPos = new Vec3(targetX + dir.x, targetY + dir.y, targetZ + dir.z);
    const blockToPlaceOn = bot.blockAt(checkPos);

    if (!blockToPlaceOn || blockToPlaceOn.name === 'air' || blockToPlaceOn.boundingBox !== 'block') continue;

    // Buiten reach plaatsen faalt altijd; dan kost het alleen tijd om het te proberen.
    // Meten vanaf de OGEN, niet vanaf de voeten: de server rekent reach ook zo, en een
    // fakkel op de vloer ligt vanaf de voeten net iets te ver terwijl hij prima te plaatsen is.
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    if (eye.distanceTo(checkPos.offset(0.5, 0.5, 0.5)) > 5) continue;

    try {
      await bot.equip(item, 'hand');
      // Via placeBlockAllowed: het minen draait nu met canPlace=false (anders bouwt de
      // pathfinder bruggetjes die hij nooit opruimt), en dan blokkeert de guard in Index.js
      // ook onze eigen fakkels en kisten. Dit is de bewuste uitzondering.
      await placeBlockAllowed(bot, blockToPlaceOn, new Vec3(-dir.x, -dir.y, -dir.z));
      return true;
    } catch (err) {
      Logger.debug(`Plaatsen mislukt naast ${checkPos}: ${err.message}`);
    }
  }

  Logger.debug(`Geen geschikt vlak gevonden om ${item.name} te plaatsen op ${targetX} ${targetY} ${targetZ}`);
  return false;
}

async function storeBlocksInChest(bot, x, y, z) {
  try {
    Logger.debug(`Zoeken naar kist rond ${x} ${y} ${z}...`);
    let chestPos = findNearestBlock(bot, CHEST_BLOCKS, 10);

    if (!chestPos) {
      Logger.debug('Geen kist gevonden, probeer er een te plaatsen');
      // Exacte namen: een suffix-match op 'chest' pakt ook ender_chest, en die wil de bot
      // niet zomaar in een tunnel neerzetten.
      if (!findItemExact(bot, CHEST_BLOCKS)) {
        Logger.warn('Geen kisten in inventaris!');
        bot.chat('Ik heb geen kisten in mijn inventaris!');
        return false;
      }

      const chestPlaced = await placeBlock(bot, CHEST_BLOCKS, x, y, z, SIDE_DIRECTIONS, true);
      if (!chestPlaced) {
        Logger.warn('Kon geen kist plaatsen - geen blok beschikbaar');
        return false;
      }

      chestPos = findNearestBlock(bot, CHEST_BLOCKS, 10);
      if (!chestPos) {
        Logger.error('Kist geplaatst maar niet gevonden!');
        return false;
      }
    }

    const chestBlock = bot.blockAt(chestPos);
    if (!chestBlock) {
      Logger.warn('Kist staat in een niet-geladen chunk');
      return false;
    }

    Logger.debug(`Kist geopend op ${chestPos.x} ${chestPos.y} ${chestPos.z}`);
    const chestWindow = await bot.openBlock(chestBlock);

    try {
      const itemsToStore = bot.inventory.items().filter(item => !isItemToKeep(bot, item.name));
      Logger.debug(`${itemsToStore.length} items te opslaan`);

      for (const item of itemsToStore) {
        try {
          await chestWindow.deposit(item.type, null, item.count);
        } catch (err) {
          Logger.warn(`Kon item ${item.name} (count: ${item.count}) niet opslaan: ${err.message}`);
        }
      }
    } finally {
      // Zonder dit blijft het venster openstaan als een deposit hard faalt, en dan weigert
      // de server elke volgende openBlock().
      chestWindow.close();
    }

    Logger.info('Blokken succesvol opgeslagen in kist');
    bot.chat('Blokken opgeslagen, minen hervat!');
    return true;

  } catch (err) {
    Logger.error('Chest storage error', err);
    bot.chat('Fout bij opslaan in kist.');
    return false;
  }
}

/**
 * Bepaalt de vloercellen van een gang van `from` naar `to`.
 *
 * Er wordt per stap maar één as tegelijk bewogen (die met de grootste resterende afstand),
 * zodat er een trapvormig maar altijd beloopbaar pad ontstaat. Diagonale sprongen zouden
 * een gang opleveren waar de bot zelf niet doorheen kan.
 */
function corridorCells(from, to) {
  const cells = [];
  let cur = from.floored();
  const target = to.floored();
  cells.push(cur);

  for (let guard = 0; guard < 4096 && !cur.equals(target); guard++) {
    const dx = target.x - cur.x;
    const dy = target.y - cur.y;
    const dz = target.z - cur.z;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);

    let step;
    if (ax >= az && ax >= ay) step = new Vec3(Math.sign(dx), 0, 0);
    else if (az >= ay) step = new Vec3(0, 0, Math.sign(dz));
    else step = new Vec3(0, Math.sign(dy), 0);

    cur = cur.plus(step);
    cells.push(cur);
  }
  return cells;
}

/**
 * De blokken die weg moeten voor één cel van de gang: `hoogte` blokken omhoog vanaf de
 * vloercel, `breedte` blokken breed haaks op de looprichting.
 *
 * Van BOVEN naar BENEDEN gesorteerd. Andersom (zoals het eerst deed) groef de bot eerst het
 * blok onder zijn eigen voeten weg terwijl het blok op hoofdhoogte er nog stond — dan kan hij
 * er nog niet in staan, en valt grind van boven meteen weer in het verse gat.
 */
function crossSection(cell, travelDir, breedte, hoogte) {
  // Haaks op de looprichting: loopt hij over x, dan ligt de breedte over z en omgekeerd.
  const perp = travelDir.x !== 0 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);

  const half = Math.floor(breedte / 2);
  const blocks = [];
  for (let h = hoogte - 1; h >= 0; h--) {
    for (let w = -half; w < breedte - half; w++) {
      blocks.push(cell.offset(perp.x * w, h, perp.z * w));
    }
  }
  return blocks;
}

/** Lava naast het blok dat je weghaalt betekent een tunnel vol lava. Niet doen dus. */
function lavaNearby(bot, pos) {
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const neighbour = bot.blockAt(pos.offset(d[0], d[1], d[2]));
    if (neighbour && neighbour.name.includes('lava')) return true;
  }
  return false;
}

const UNBREAKABLE = ['bedrock', 'obsidian', 'barrier', 'end_portal', 'nether_portal', 'reinforced_deepslate'];

function withinReach(bot, pos) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  return eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.5;
}

async function mineTunnel(bot, startX, startY, startZ, richting, diepte, hoogte = 2, breedte = 1) {
  const dir = DIRECTIONS[richting];
  if (!dir) {
    Logger.warn(`Ongeldige richting: ${richting}`);
    bot.chat('Ongeldige richting. Gebruik: north/south/east/west');
    return;
  }

  if (!Number.isFinite(diepte) || !Number.isFinite(hoogte) || !Number.isFinite(breedte) ||
      breedte < 1 || hoogte < 2 || diepte < 1) {
    bot.chat('Breedte minimaal 1, hoogte minimaal 2, diepte minimaal 1!');
    return;
  }

  const from = new Vec3(Math.floor(startX), Math.floor(startY), Math.floor(startZ));
  const to = from.offset(dir.x * diepte, 0, dir.z * diepte);
  return mineCorridor(bot, from, to, { hoogte, breedte, label: `${diepte} blokken naar ${richting}` });
}

/**
 * Graaft een gang van `from` naar `to`.
 *
 * Belangrijkste verschil met de oude opzet: de pathfinder mag hier NIET graven. Daarvoor
 * stond canDig op true en werd er voor elk blok buiten bereik een goto gedaan — de pathfinder
 * groef dan zijn eigen route ernaartoe, dwars door de wand, over de tunnel heen, waar hij maar
 * wilde. Dat is de "rare" gangen en de losse gaten naast de tunnel. Nu graaft alleen deze
 * functie, en loopt de bot uitsluitend door de gang die hij zelf al vrijgemaakt heeft.
 */
async function mineCorridor(bot, from, to, { hoogte = 2, breedte = 1, label = null, resumeFrom = 0 } = {}) {
  if (!Number.isFinite(hoogte) || !Number.isFinite(breedte) || breedte < 1 || hoogte < 2) {
    bot.chat('Breedte minimaal 1, hoogte minimaal 2!');
    return;
  }

  const cells = corridorCells(from, to);
  if (cells.length < 2) {
    bot.chat('Dat is geen tunnel, dat is één blok.');
    return;
  }

  // Elke run claimt een eigen sessienummer. Start er een tweede tunnel (bijvoorbeeld doordat
  // restoreGoal() na een dood opnieuw begint terwijl de oude loop nog draait), dan ziet de
  // oude run dat het nummer veranderd is en stopt hij zonder de state van de nieuwe te wissen.
  const session = ++botState.miningSession;

  botState.isMining = true;
  // Een eerdere !stop laat stopMining op true staan. Zonder deze reset breekt de eerstvolgende
  // tunnel meteen weer af zodra hij begint.
  botState.stopMining = false;

  let stoppedEarly = false;
  let superseded = false;
  const shouldStop = () => {
    if (botState.miningSession !== session) { superseded = true; return true; }
    if (!botState.isMining || botState.stopMining) { stoppedEarly = true; return true; }
    return false;
  };

  const describe = label ?? `${cells.length - 1} blokken naar ${to.x} ${to.y} ${to.z}`;
  Logger.info(`MINING START: ${from} -> ${to} (${cells.length} cellen, ${breedte} breed, ${hoogte} hoog)`);
  bot.chat(`Tunnel: ${describe} (${breedte} breed, ${hoogte} hoog)`);

  let blocksMined = 0;
  let blocksSkipped = 0;
  let cellIndex = resumeFrom;
  const startTime = Date.now();

  // Naar de ingang lopen mag mét graven: daar is nog geen gang om doorheen te lopen.
  setMovements(bot, { canDig: true, canPlace: false });
  try {
    await abortable(
      bot.pathfinder.goto(new goals.GoalNear(cells[resumeFrom].x, cells[resumeFrom].y, cells[resumeFrom].z, 2)),
      shouldStop,
      () => bot.pathfinder.stop()
    );
  } catch (err) {
    Logger.warn(`Kon niet naar de ingang lopen: ${err.message}`);
    if (err.name === 'NoPath' || err.name === 'Timeout') {
      bot.chat(`Ik kan niet bij het beginpunt komen (${err.name}).`);
    }
  }

  // Vanaf hier graaft ALLEEN deze functie. De pathfinder mag niets meer slopen, dus de bot
  // loopt uitsluitend door de gang die hier gemaakt wordt.
  setMovements(bot, { canDig: false, canPlace: false });

  try {
    for (; cellIndex < cells.length; cellIndex++) {
      if (shouldStop()) break;

      const cell = cells[cellIndex];
      // Looprichting uit de stap naar de volgende cel; bij een verticale stap (trap) de
      // vorige horizontale richting aanhouden, anders staat de breedte ineens dwars.
      let travel = cells[cellIndex + 1]?.minus(cell) ?? cell.minus(cells[cellIndex - 1] ?? cell);
      if (travel.x === 0 && travel.z === 0) {
        const prev = cells[cellIndex - 1];
        travel = prev ? cell.minus(prev) : new Vec3(1, 0, 0);
        if (travel.x === 0 && travel.z === 0) travel = new Vec3(1, 0, 0);
      }

      // Onthouden waar we zijn, zodat we na een dood verder kunnen i.p.v. opnieuw te beginnen.
      botState.lastMineData = { from, to, hoogte, breedte, label, resumeFrom: cellIndex };

      const freeSlots = bot.inventory.emptySlotCount();
      if (freeSlots <= CONFIG.physics.inventoryFullThreshold) {
        Logger.debug('Inventaris vol, opslaan...');
        await storeBlocksInChest(bot, cell.x, cell.y, cell.z);
        if (shouldStop()) break;
        setMovements(bot, { canDig: false, canPlace: false });
      }

      for (const target of crossSection(cell, travel, breedte, hoogte)) {
        if (shouldStop()) break;

        const block = bot.blockAt(target);
        if (!block || block.name === 'air' || block.name === 'cave_air' || block.name.includes('chest')) continue;

        if (UNBREAKABLE.some(n => block.name.includes(n))) {
          Logger.debug(`${block.name} op ${target} overgeslagen (onbreekbaar)`);
          blocksSkipped++;
          continue;
        }

        // Nieuw: niet in een lavazak graven. Dat liep vroeger uit op een tunnel vol lava.
        if (lavaNearby(bot, target)) {
          Logger.warn(`Lava naast ${target}, blok overgeslagen`);
          bot.chat('Lava in de weg, ik graaf er omheen!');
          blocksSkipped++;
          continue;
        }

        // Binnen bereik blijven door in de gang mee te lopen, niet door de pathfinder een
        // nieuwe route te laten uitgraven.
        if (!withinReach(bot, target)) {
          const standOn = cells[Math.max(0, cellIndex - 1)];
          try {
            await abortable(
              bot.pathfinder.goto(new goals.GoalBlock(standOn.x, standOn.y, standOn.z)),
              shouldStop,
              () => bot.pathfinder.stop()
            );
          } catch (err) {
            Logger.debug(`Kon niet naar ${standOn} lopen: ${err.message}`);
          }
          if (shouldStop()) break;
          if (!withinReach(bot, target)) {
            Logger.debug(`${target} blijft buiten bereik, overgeslagen`);
            blocksSkipped++;
            continue;
          }
        }

        try {
          await equipBestTool(bot, block.name);
          if (await safeDig(bot, block, 15000, shouldStop)) {
            blocksMined++;
            blocksMined += await digFallingBlocks(bot, target, shouldStop);
          } else {
            blocksSkipped++;
          }
        } catch (err) {
          Logger.debug(`Block error op ${target}: ${err.message}`);
          blocksSkipped++;
        }
      }

      // Fakkels op vaste afstand langs de gang i.p.v. per zoveel gebroken blokken. Dat laatste
      // liep uit de pas zodra er grind bij kwam of er blokken werden overgeslagen.
      if (cellIndex % CONFIG.physics.torchPlaceInterval === 0) {
        await placeBlock(bot, 'torch', cell.x, cell.y, cell.z, TORCH_DIRECTIONS);
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    if (!superseded) {
      botState.isMining = false;
      botState.stopMining = false;
      botState.lastMineData = null;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (superseded) {
    Logger.info(`Mining-run afgebroken (nieuwe tunnel gestart). ${blocksMined} blokken gemineed.`);
    return;
  }

  if (stoppedEarly) {
    Logger.info(`Mining gestopt door gebruiker bij cel ${cellIndex}/${cells.length}. ${blocksMined} blokken gemineed.`);
    bot.chat(`Mining gestopt (${cellIndex} van ${cells.length} gedaan).`);
  } else {
    Logger.info(`MINING KLAAR: ${blocksMined} blokken gemineed, ${blocksSkipped} overgeslagen in ${duration}s`);
    bot.chat(`Tunnel klaar! ${blocksMined} blokken weggegraven.`);
  }
}

async function restoreGoal(bot) {
  if (botState.lastMineData) {
    // resumeFrom: na een dood gaat hij verder waar hij gebleven was. Eerder begon hij de
    // hele tunnel opnieuw vanaf het begin, wat bij een lange gang minutenlang door al
    // uitgegraven gang lopen betekende.
    const { from, to, hoogte, breedte, label, resumeFrom } = botState.lastMineData;
    Logger.info(`Tunnel hervatten vanaf cel ${resumeFrom}`);
    await mineCorridor(bot, new Vec3(from.x, from.y, from.z), new Vec3(to.x, to.y, to.z),
      { hoogte, breedte, label, resumeFrom });
  } else if (botState.lastGoal) {
    const goal = botState.lastGoal;
    if (goal.type === 'goto') {
      bot.pathfinder.setGoal(new goals.GoalBlock(goal.x, goal.y, goal.z));
    } else if (goal.type === 'follow') {
      const target = bot.players[goal.username]?.entity;
      if (target) {
        bot.pathfinder.stop();
        bot.pathfinder.setGoal(new goals.GoalFollow(target, CONFIG.pathfinding.followDistance), true);
      }
    }
  }
}

module.exports = { mineTunnel, mineCorridor, corridorCells, crossSection, storeBlocksInChest, restoreGoal, safeDig };

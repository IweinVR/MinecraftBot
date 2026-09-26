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
 *   - voorraadkisten gaan in een zelfgegraven nis in de wand, niet in de gang zelf
 *   - er wordt per rij alleen voor ERTS gestopt; "collect" achter het commando raapt alles op
 *   - te grote maten gaan naar mineRoom(), dat de kamer in stroken en lagen knipt
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG, DIRECTIONS, SIDE_DIRECTIONS, CHEST_BLOCKS } = require('../config');
const botState = require('../state');
const { Logger, setMovements, findItem, findItemExact, isItemToKeep, findNearestBlock, placeBlockAllowed, abortable, withTimeout } = require('../utils');
const { openContainerAt, closeWindow } = require('../lib/containers');
const { categoryOf } = require('../data/categories');

const MINING = CONFIG.mining;

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

/**
 * Waar de bot wél voor omloopt als hij niet alles opraapt.
 *
 * De categorieën komen uit data/categories.js, zodat er niet nóg een lijst met "wat is
 * waardevol" door de bot zwerft. Let op dat het om de DROPS gaat en niet om de blokken: een
 * diamond_ore laat een 'diamond' vallen, en die valt onder metaal_en_edelsteen.
 */
const WAARDEVOLLE_CATEGORIEEN = new Set(['erts', 'metaal_en_edelsteen', 'grondstofblokken']);

// Redstone hoort in data/categories.js bij de redstone-categorie, samen met zuigers en rails.
// Het is wél gewoon een ertsdrop, dus hier apart. Hetzelfde voor de dingen die je alleen
// diep onder de grond tegenkomt.
const WAARDEVOLLE_ITEMS = new Set(['redstone', 'glowstone_dust', 'echo_shard', 'ancient_debris']);

/**
 * Is deze drop de moeite waard om voor te stoppen?
 *
 * Kan het item niet gelezen worden (de metadata van de entity is nog niet binnen), dan telt
 * hij als niet-waardevol. Dat is de veilige kant op: één gemiste kool is minder erg dan een
 * bot die alsnog voor elke brok steen omloopt.
 */
function isWaardevolleDrop(bot, entity) {
  let item = null;
  try {
    item = entity.getDroppedItem();
  } catch (err) {
    return false;
  }
  if (!item?.name) return false;
  return WAARDEVOLLE_ITEMS.has(item.name)
    || WAARDEVOLLE_CATEGORIEEN.has(categoryOf(bot.registry, item.name));
}

/** Alle item-entities binnen een straal, dichtstbij eerst. Zelfde aanpak als in farming.js. */
function nearbyDrops(bot, radius) {
  return Object.values(bot.entities)
    .filter(e => e && e.name === 'item' && e.position)
    .map(e => ({ entity: e, distance: bot.entity.position.distanceTo(e.position) }))
    .filter(d => d.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Naar een drop lopen tot hij opgeraapt is. Geeft false als de bot er niet bij kon.
 *
 * GoalNear met straal 1 laat de bot soms net buiten Minecrafts oprapradius staan; ligt het
 * item er na aankomst nog, dan schuift de bot er alsnog bovenop (straal 0). Zie collectDrop
 * in farming.js voor dezelfde redenering.
 */
async function collectDrop(bot, entity) {
  const pos = entity.position;

  for (const range of [1, 0]) {
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)),
        MINING.dropSweepTimeout,
        'drop oprapen'
      );
    } catch (err) {
      Logger.debug(`Drop oprapen overgeslagen: ${err.message}`);
      return !entity.isValid;
    }
    await new Promise(resolve => setTimeout(resolve, MINING.dropPickupDelay));
    if (!entity.isValid) return true;
  }

  return !entity.isValid;
}

/**
 * In een brede of hoge gang valt niet elk gemined blok op het looppad van de bot: Minecraft
 * raapt alleen op wat binnen ongeveer 1 blok van de speler ligt, en de kruisdoorsnede reikt
 * verder dan dat. Na elke laag (cel) even om zich heen kijken vangt die achterblijvers op,
 * zonder dat de bot voor elk los blok een aparte omweg hoeft te maken tijdens het graven zelf.
 *
 * Standaard gebeurt dat alleen voor erts. Alles oprapen betekent namelijk dat de bot bij elke
 * rij van zijn graafpunt weg loopt naar elke losse brok steen en weer terug, en dat kost bij
 * een lange gang meer tijd dan het graven zelf. Met `alles` (het woord "collect" achter het
 * tunnelcommando) doet hij het oude gedrag: alles wat los ligt gaat mee.
 */
async function sweepMiningDrops(bot, shouldStop, { alles = false } = {}) {
  let collected = 0;
  for (const { entity } of nearbyDrops(bot, MINING.dropSweepRadius)) {
    if (shouldStop()) break;
    if (!entity.isValid) continue;
    if (!alles && !isWaardevolleDrop(bot, entity)) continue;
    if (await collectDrop(bot, entity)) collected++;
  }
  return collected;
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

/**
 * @param {object} [gang] de gang waarin we staan: {travel, breedte, hoogte, inCorridor,
 *   shouldStop}. Is die bekend, dan graaft de bot voor een nieuwe kist eerst een nis in de
 *   wand. Zonder die gegevens valt hij terug op het oude gedrag (tegen een zijvlak aan).
 */
async function storeBlocksInChest(bot, x, y, z, gang = null) {
  const shouldStop = gang?.shouldStop ?? (() => false);

  try {
    Logger.debug(`Zoeken naar kist rond ${x} ${y} ${z}...`);
    let chestPos = findNearestBlock(bot, CHEST_BLOCKS, MINING.chestSearchRadius);

    if (!chestPos) {
      Logger.debug('Geen kist gevonden, probeer er een te plaatsen');
      // Exacte namen: een suffix-match op 'chest' pakt ook ender_chest, en die wil de bot
      // niet zomaar in een tunnel neerzetten.
      if (!findItemExact(bot, CHEST_BLOCKS)) {
        Logger.warn('Geen kisten in inventaris!');
        bot.chat('Ik heb geen kisten in mijn inventaris!');
        return false;
      }

      // Waarom niet gewoon op (x, y, z): dat is de cel waar de bot zélf in staat en die
      // bovendien vaak nog dichtgemetseld is. Je kunt geen blok in jezelf of in steen
      // plaatsen, dus dit mislukte in de praktijk vrijwel altijd.
      const chestPlaced = gang
        ? await placeChestInWall(bot, new Vec3(x, y, z), gang)
        : await placeBlock(bot, CHEST_BLOCKS, x, y, z, SIDE_DIRECTIONS, true);
      if (!chestPlaced) {
        Logger.warn('Kon geen kist plaatsen - geen blok beschikbaar');
        return false;
      }

      chestPos = findNearestBlock(bot, CHEST_BLOCKS, MINING.chestSearchRadius);
      if (!chestPos) {
        Logger.error('Kist geplaatst maar niet gevonden!');
        return false;
      }
    }

    // Via openContainerAt en niet via bot.openBlock(): de kist staat zelden binnen
    // handbereik (hij mag tot chestSearchRadius blokken verderop staan), en dan stuurt de
    // server geen windowOpen terug. Hier wordt er eerst naartoe gelopen, met een timeout,
    // en wordt er niets plaatsbaars vastgehouden -- anders leest de server het openen bij
    // een mislukking als een block_place en zet de bot midden in de gang een blok neer.
    const chestWindow = await openContainerAt(bot, chestPos, shouldStop, {
      ...MINING, allowed: CHEST_BLOCKS, label: 'kist',
    });
    if (!chestWindow) {
      Logger.warn(`Kon de kist op ${chestPos.x} ${chestPos.y} ${chestPos.z} niet openen`);
      return false;
    }
    Logger.debug(`Kist geopend op ${chestPos.x} ${chestPos.y} ${chestPos.z}`);

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
      // de server elke volgende openBlock(). Via closeWindow() wordt er ook echt gewacht
      // tot de server het venster dicht heeft; window.close() zelf wacht nergens op.
      await closeWindow(bot, chestWindow, MINING);
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

// Water en lava lijken "gewoon" diggable (minecraft-data zet dat zelfs op true voor water),
// maar de hardness (100) geeft een digTime van tientallen seconden i.p.v. de Infinity die je
// bij bedrock krijgt. Daardoor gaf UNBREAKABLE hierboven geen snelle misser: de bot stond een
// volle safeDig-timeout stil te "graven" aan een blok dat toch nooit stukgaat. Overslaan dus,
// net als lucht — lopen/zwemmen erdoorheen kan gewoon.
const LIQUIDS = ['water', 'lava'];

function withinReach(bot, pos) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  return eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.5;
}

/**
 * De twee plekken naast de gang waar een kist zou kunnen staan: net buiten de breedte die
 * crossSection() uitgraaft, links en rechts op vloerhoogte.
 */
function chestAlcoves(cell, travelDir, breedte) {
  const perp = travelDir.x !== 0 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  const half = Math.floor(breedte / 2);
  const rechts = breedte - half;   // eerste kolom voorbij de rechterrand
  const links = -half - 1;         // en die voorbij de linkerrand
  return [
    cell.offset(perp.x * rechts, 0, perp.z * rechts),
    cell.offset(perp.x * links, 0, perp.z * links),
  ];
}

/**
 * Zet een voorraadkist in een zelfgegraven nis naast de gang.
 *
 * Twee redenen om het zo te doen in plaats van de kist gewoon in de gang te zetten:
 *
 *  1. Plek. De oude aanpak mikte op de cel waar de bot zelf stond, en die was bovendien vaak
 *     nog niet uitgegraven. In je eigen hitbox of in massief steen kun je niets plaatsen, dus
 *     "Kon geen kist plaatsen" was eerder regel dan uitzondering. Een nis graven we zelf, dus
 *     daar ís altijd ruimte.
 *  2. Doorgang. De graaflus slaat kisten bewust over (anders sloopt hij zijn eigen voorraad),
 *     dus een kist midden in een gang van één breed blijft staan en zet de gang dicht.
 *
 * @param {{travel: Vec3, breedte: number, inCorridor?: function, shouldStop?: function}} gang
 */
async function placeChestInWall(bot, cell, gang) {
  const { travel, breedte = 1, inCorridor = null, shouldStop = () => false } = gang;
  if (!findItemExact(bot, CHEST_BLOCKS)) return false;

  for (const nis of chestAlcoves(cell, travel, breedte)) {
    if (shouldStop()) return false;

    const blok = bot.blockAt(nis);
    if (!blok) continue;
    if (blok.name.includes('chest')) return true;                  // hier staat er al een
    // Bij een bocht ligt de zijkant van deze cel soms precies op het pad van het volgende
    // stuk gang. Daar een kist neerzetten metselt de bot zijn eigen route dicht.
    if (inCorridor && inCorridor(nis)) continue;
    if (LIQUIDS.some(n => blok.name.includes(n))) continue;        // geen water/lava openbreken
    if (lavaNearby(bot, nis)) continue;

    const alVrij = blok.name === 'air' || blok.name === 'cave_air';
    if (!alVrij) {
      if (UNBREAKABLE.some(n => blok.name.includes(n))) continue;
      if (!withinReach(bot, nis)) continue;
      await equipBestTool(bot, blok.name);
      if (!await safeDig(bot, blok, 15000, shouldStop)) continue;
      // Zand of grind van boven valt zo de verse nis in, en dan staat de kist er niet.
      await digFallingBlocks(bot, nis, shouldStop);
    }

    // De vloer onder de nis eerst: dat vlak is er altijd. Lukt dat niet (nis boven een
    // grot), dan alsnog tegen een van de wanden.
    const geplaatst = await placeBlock(
      bot, CHEST_BLOCKS, nis.x, nis.y, nis.z, [{ x: 0, y: -1, z: 0 }, ...SIDE_DIRECTIONS], true
    );
    if (geplaatst) {
      Logger.info(`Voorraadkist geplaatst op ${nis.x} ${nis.y} ${nis.z}`);
      return true;
    }
  }

  Logger.debug(`Geen nis gevonden voor een kist bij ${cell}`);
  return false;
}

async function mineTunnel(bot, startX, startY, startZ, richting, diepte, hoogte = 2, breedte = 1, opts = {}) {
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
  return mineCorridor(bot, from, to, { ...opts, hoogte, breedte, label: `${diepte} blokken naar ${richting}` });
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
async function mineCorridor(bot, from, to, { hoogte = 2, breedte = 1, label = null, resumeFrom = 0, collect = false, stil = false } = {}) {
  if (!Number.isFinite(hoogte) || !Number.isFinite(breedte) || breedte < 1 || hoogte < 2) {
    bot.chat('Breedte minimaal 1, hoogte minimaal 2!');
    return { gedaan: 0, gestopt: false, ingehaald: false };
  }

  // Een gang van 20 bij 20 kan hij niet in één doorgang: verder dan vier blokken omhoog en
  // vier opzij komt hij niet vanaf het looppad. mineRoom() hakt zulke maten in stroken en
  // lagen en belandt per doorgang gewoon weer hier, met maten die wél kunnen.
  if (breedte > MINING.maxBreedte || hoogte > MINING.maxHoogte) {
    return mineRoom(bot, from, to, { hoogte, breedte, label, collect });
  }

  const cells = corridorCells(from, to);
  if (cells.length < 2) {
    bot.chat('Dat is geen tunnel, dat is één blok.');
    return { gedaan: 0, gestopt: false, ingehaald: false };
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
  if (!stil) {
    bot.chat(`Tunnel: ${describe} (${breedte} breed, ${hoogte} hoog)`
      + (collect ? ', ik raap alles op' : ', ik stop alleen voor erts'));
  }

  let blocksMined = 0;
  let blocksSkipped = 0;
  let cellIndex = resumeFrom;
  const startTime = Date.now();

  // Hoeveel fakkels er al staan; elke zoveelste krijgt een kist in de wand.
  let torches = 0;
  let kistenOp = false;

  // Ligt dit punt in de gang zelf (inclusief de breedte en hoogte)? Conservatief: een cel
  // telt mee tot 'half' blokken opzij, ongeacht de looprichting daar. Gebruikt om te
  // voorkomen dat een kist in een bocht op het pad van het volgende stuk belandt.
  const half = Math.floor(breedte / 2);
  const inCorridor = (pos) => cells.some(c =>
    Math.abs(pos.x - c.x) <= half && Math.abs(pos.z - c.z) <= half
    && pos.y >= c.y && pos.y < c.y + hoogte);

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
      // collect hoort hierbij: na een dood hervat hij anders in de andere stand dan waar
      // je om gevraagd had.
      botState.lastMineData = { from, to, hoogte, breedte, label, collect, resumeFrom: cellIndex };

      const freeSlots = bot.inventory.emptySlotCount();
      if (freeSlots <= CONFIG.physics.inventoryFullThreshold) {
        Logger.debug('Inventaris vol, opslaan...');
        await storeBlocksInChest(bot, cell.x, cell.y, cell.z,
          { travel, breedte, hoogte, inCorridor, shouldStop });
        if (shouldStop()) break;
        setMovements(bot, { canDig: false, canPlace: false });
      }

      for (const target of crossSection(cell, travel, breedte, hoogte)) {
        if (shouldStop()) break;

        const block = bot.blockAt(target);
        if (!block || block.name === 'air' || block.name === 'cave_air' || block.name.includes('chest')) continue;
        if (LIQUIDS.some(n => block.name.includes(n))) continue;

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

      if (!shouldStop()) {
        const swept = await sweepMiningDrops(bot, shouldStop, { alles: collect });
        if (swept > 0) Logger.debug(`${swept} achtergebleven drop(s) opgeraapt bij ${cell}`);
      }

      // Fakkels op vaste afstand langs de gang i.p.v. per zoveel gebroken blokken. Dat laatste
      // liep uit de pas zodra er grind bij kwam of er blokken werden overgeslagen.
      if (cellIndex % CONFIG.physics.torchPlaceInterval === 0) {
        await placeBlock(bot, 'torch', cell.x, cell.y, cell.z, TORCH_DIRECTIONS);
        torches++;

        // Om de zoveel fakkels een kist in de wand, zodat er altijd een binnen tien blokken
        // staat als de inventaris volloopt. Vanaf de TWEEDE fakkel: bij de eerste staat de
        // bot nog in de ingang, waar de gang vaak nog niet vrij is.
        const perKist = CONFIG.physics.chestPerTorches;
        if (perKist > 0 && torches % perKist === 0 && !shouldStop()) {
          if (!findItemExact(bot, CHEST_BLOCKS)) {
            // Eén keer melden, niet bij elke fakkel opnieuw.
            if (!kistenOp) {
              kistenOp = true;
              bot.chat('Ik heb geen kisten meer om onderweg neer te zetten.');
            }
          } else {
            kistenOp = false;
            await placeChestInWall(bot, cell, { travel, breedte, inCorridor, shouldStop });
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    // Zie de opmerking in farming.js: de sessie wordt hier opnieuw vergeleken, want een oude
    // run die pas nu bij zijn finally aankomt mag de state van een nieuwe niet leegmaken.
    if (!superseded && botState.miningSession === session) {
      botState.isMining = false;
      botState.stopMining = false;
      botState.lastMineData = null;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Het resultaat gaat terug naar de aanroeper. mineRoom() heeft dat nodig: zonder te weten
  // dat deze doorgang door !stop is afgebroken, begint hij vrolijk aan de volgende -- en die
  // zet stopMining bij het starten weer op false.
  const resultaat = { gedaan: blocksMined, overgeslagen: blocksSkipped, gestopt: stoppedEarly, ingehaald: superseded };

  if (superseded) {
    Logger.info(`Mining-run afgebroken (nieuwe tunnel gestart). ${blocksMined} blokken gemineed.`);
    return resultaat;
  }

  if (stoppedEarly) {
    Logger.info(`Mining gestopt door gebruiker bij cel ${cellIndex}/${cells.length}. ${blocksMined} blokken gemineed.`);
    if (!stil) bot.chat(`Mining gestopt (${cellIndex} van ${cells.length} gedaan).`);
  } else {
    Logger.info(`MINING KLAAR: ${blocksMined} blokken gemineed, ${blocksSkipped} overgeslagen in ${duration}s`);
    if (!stil) bot.chat(`Tunnel klaar! ${blocksMined} blokken weggegraven.`);
  }

  return resultaat;
}

// ---------------------------------------------------------------------------
// Grote kamers: stroken en lagen
// ---------------------------------------------------------------------------

/**
 * De breedte opdelen in stroken die de bot wél kan bijhouden, van RECHTS naar links.
 *
 * crossSection() legt de breedte om de hartlijn heen: bij breedte 9 loopt hij van vier links
 * tot vier rechts. Een strook van negen tegen de rechterwand heeft zijn hartlijn dus op het
 * vijfde blok vanaf die wand. De laatste strook links is vaak smaller; die krijgt gewoon wat
 * er overblijft.
 *
 * @returns {{centrum: number, breedte: number}[]} centrum = offset haaks op de looprichting
 */
function kamerStroken(breedte, max) {
  const half = Math.floor(breedte / 2);
  const links = -half;
  const stroken = [];

  for (let rechts = breedte - half - 1; rechts >= links;) {
    const s = Math.min(max, rechts - links + 1);
    const rand = rechts - s + 1;
    stroken.push({ centrum: rand + Math.floor(s / 2), breedte: s });
    rechts = rand - 1;
  }

  return stroken;
}

/**
 * De hoogte opdelen in lagen, van BOVEN naar beneden.
 *
 * Van boven beginnen is geen willekeurige keuze: onder elke laag ligt dan nog vaste steen,
 * dus de bot heeft altijd een vloer. Andersom zou hij na de eerste laag in het luchtledige
 * moeten staan en zich omhoog moeten torenen, en blokken plaatsen doet deze bot niet.
 *
 * @param {number} vloerY de onderste blokrij van de kamer
 * @returns {{voeten: number, hoogte: number}[]} voeten = op welke hoogte hij staat te graven
 */
function kamerLagen(vloerY, hoogte, max) {
  const lagen = [];

  for (let top = vloerY + hoogte - 1; top >= vloerY;) {
    const h = Math.min(max, top - vloerY + 1);
    const voeten = top - h + 1;
    lagen.push({ voeten, hoogte: h });
    top = voeten - 1;
  }

  // Blijft er onderaan één rij over (hoogte 5, 9, 13...), dan leent die er eentje van de laag
  // erboven. Een doorgang van één hoog bestaat namelijk niet: daar past de bot zelf niet in,
  // en mineCorridor weigert hem dan ook.
  const onderste = lagen[lagen.length - 1];
  if (lagen.length >= 2 && onderste.hoogte === 1) {
    const erboven = lagen[lagen.length - 2];
    onderste.hoogte = 2;
    erboven.voeten += 1;
    erboven.hoogte -= 1;
  }

  return lagen;
}

/**
 * Zakken naar de volgende laag door onder je eigen voeten weg te graven.
 *
 * Dat klinkt roekelozer dan het is: hij valt per blok maar één blokje, en de blokken die hij
 * weghaalt horen toch bij de laag die hierna aan de beurt is. Het alternatief -- naar beneden
 * springen -- kost valschade zodra een laag vier hoog is.
 */
async function zakNaarLaag(bot, doelY, shouldStop) {
  for (let stap = 0; stap < MINING.maxAfdaling; stap++) {
    if (shouldStop()) return false;
    if (Math.floor(bot.entity.position.y) <= doelY) return true;

    const onder = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!onder) return false;

    if (LIQUIDS.some(n => onder.name.includes(n)) || UNBREAKABLE.some(n => onder.name.includes(n))) {
      bot.chat(`Er zit ${onder.name} onder me, ik kan niet dieper.`);
      return false;
    }
    if (lavaNearby(bot, onder.position)) {
      bot.chat('Lava naast de vloer, ik graaf hier niet verder naar beneden.');
      return false;
    }

    await equipBestTool(bot, onder.name);
    if (!await safeDig(bot, onder, 15000, shouldStop)) return false;

    // Even wachten tot hij echt gevallen is; anders graaft hij het volgende blok weg terwijl
    // hij nog op het oude niveau hangt en zakt hij per saldo niets.
    await new Promise(resolve => setTimeout(resolve, MINING.descendDelay));
  }

  return Math.floor(bot.entity.position.y) <= doelY;
}

/**
 * Een kamer uitgraven die te groot is voor één doorgang.
 *
 * De kamer wordt in stroken (maxBreedte) en lagen (maxHoogte) geknipt, en elke strook is
 * gewoon weer een doorgang van mineCorridor -- inclusief fakkels, wandkisten, lava-omzeiling
 * en het oprapen van erts. De volgorde is waar het hier om gaat:
 *
 *  1. Eerst een TRAP van één breed schuin omhoog naar de bovenste laag. corridorCells() zet
 *     per stap maar één as om, dus een schuine lijn wordt vanzelf een traptrede: één vooruit,
 *     één omhoog. Die trap ligt binnen de kamer en verdwijnt dus vanzelf als de lagen eronder
 *     aan de beurt komen. Daarom moet de kamer wel minstens zo lang zijn als hij hoog is.
 *  2. Per laag van rechts naar links, strook voor strook, om en om heen en terug. De eerste
 *     strook ligt tegen de rechterwand met zijn hartlijn op het vijfde blok.
 *  3. Aan het eind van een laag graaft hij zich ter plekke naar beneden en begint de volgende
 *     laag aan de kant waar hij toevallig al staat.
 */
async function mineRoom(bot, from, to, { hoogte = 2, breedte = 1, label = null, collect = false } = {}) {
  const verschil = to.minus(from);
  if (verschil.y !== 0 || (verschil.x !== 0 && verschil.z !== 0)) {
    bot.chat('Voor zo\'n grote kamer moet ik een rechte richting hebben, bv. !tunnel oost 20 20 20.');
    return { gedaan: 0, gestopt: false, ingehaald: false };
  }

  const perp = verschil.x !== 0 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  const lengte = Math.abs(verschil.x) + Math.abs(verschil.z) + 1;

  const stroken = kamerStroken(breedte, MINING.maxBreedte);
  const lagen = kamerLagen(from.y, hoogte, MINING.maxHoogte);

  // De trap heeft per blok omhoog een blok vooruit nodig. Past dat niet in de lengte van de
  // kamer, dan komt hij nooit boven en heeft beginnen geen zin.
  const klim = lagen[0].voeten - from.y;
  if (klim > lengte - 1) {
    bot.chat(`Deze kamer is ${hoogte} hoog maar maar ${lengte} lang; daar kan ik geen trap in graven.`);
    bot.chat('Maak hem langer, of lager dan de lengte.');
    return { gedaan: 0, gestopt: false, ingehaald: false };
  }

  const shouldStop = () => botState.stopMining;
  const totaal = { gedaan: 0, overgeslagen: 0, gestopt: false, ingehaald: false };
  const doorgangen = stroken.length * lagen.length;

  Logger.info(`KAMER START: ${lengte}x${breedte}x${hoogte}, ${stroken.length} stroken x ${lagen.length} lagen`);
  bot.chat(`Kamer van ${lengte} lang, ${breedte} breed, ${hoogte} hoog: ${doorgangen} doorgangen.`);
  bot.chat(`Ik graaf eerst een trap ${klim} omhoog en werk dan van boven naar beneden.`);

  let omgekeerd = false;

  try {
    for (const [laagNr, laag] of lagen.entries()) {
      // Om en om van rechts naar links en terug: zo begint een nieuwe laag aan de kant waar
      // de vorige ophield, in plaats van eerst de hele breedte terug te lopen.
      const rij = laagNr % 2 === 0 ? stroken : [...stroken].reverse();
      const dy = laag.voeten - from.y;

      for (const [strookNr, strook] of rij.entries()) {
        const heen = from.plus(perp.scaled(strook.centrum)).offset(0, dy, 0);
        const terug = to.plus(perp.scaled(strook.centrum)).offset(0, dy, 0);
        const [start, eind] = omgekeerd ? [terug, heen] : [heen, terug];

        if (strookNr === 0) {
          // Tussen twee doorgangen staat isMining op false (de vorige doorgang heeft zijn
          // finally al gedraaid). Hier weer aan, zodat !stop en de andere taken zien dat de
          // bot nog bezig is terwijl hij klimt of zakt.
          botState.isMining = true;

          const gelukt = laagNr === 0
            ? await trapNaarBoven(bot, from, start, collect, shouldStop)
            : await naarStart(bot, start, lagen[laagNr - 1].voeten, shouldStop);

          if (!gelukt) {
            totaal.gestopt = true;
            break;
          }
        }

        const pas = await mineCorridor(bot, start, eind, {
          hoogte: laag.hoogte, breedte: strook.breedte, collect, stil: true,
          label: `laag ${laagNr + 1}/${lagen.length}, strook ${strookNr + 1}/${rij.length}`,
        });

        totaal.gedaan += pas.gedaan ?? 0;
        totaal.overgeslagen += pas.overgeslagen ?? 0;
        omgekeerd = !omgekeerd;

        if (pas.ingehaald) { totaal.ingehaald = true; break; }
        if (pas.gestopt) { totaal.gestopt = true; break; }
      }

      if (totaal.gestopt || totaal.ingehaald) break;
      bot.chat(`Laag ${laagNr + 1} van ${lagen.length} klaar (${totaal.gedaan} blokken tot nu toe).`);
    }
  } catch (err) {
    Logger.error('Kamerfout', err);
    bot.chat('Er ging iets mis met de kamer.');
  } finally {
    // Zelfde reden als in mineCorridor: is er intussen een nieuwe tunnel gestart, dan is deze
    // state niet meer van ons en moeten we hem met rust laten.
    if (!totaal.ingehaald) {
      botState.isMining = false;
      botState.stopMining = false;
      botState.lastMineData = null;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  Logger.info(`KAMER ${totaal.gestopt ? 'GESTOPT' : 'KLAAR'}: ${totaal.gedaan} blokken, ${totaal.overgeslagen} overgeslagen`);
  if (totaal.ingehaald) return totaal;

  if (totaal.gestopt) bot.chat(`Gestopt met de kamer, ${totaal.gedaan} blokken weggegraven.`);
  else bot.chat(`Kamer klaar! ${totaal.gedaan} blokken weggegraven${label ? ` (${label})` : ''}.`);

  return totaal;
}

/**
 * De trap naar de bovenste laag: één breed, twee hoog, schuin omhoog.
 *
 * Begint de bot er al (een kamer die wel breed maar niet hoog is), dan valt er niets te
 * klimmen en wordt er ook niets gegraven -- anders krijg je "dat is geen tunnel, dat is één
 * blok" in de chat.
 */
async function trapNaarBoven(bot, from, start, collect, shouldStop) {
  if (start.equals(from)) return true;

  const trap = await mineCorridor(bot, from, start, {
    breedte: 1, hoogte: 2, collect, stil: true, label: 'trap omhoog',
  });
  return !trap.gestopt && !trap.ingehaald && !shouldStop();
}

/**
 * Van de net leeggegraven laag naar het begin van de volgende: eerst er bovenop gaan staan,
 * dan onder je eigen voeten weg naar beneden.
 */
async function naarStart(bot, start, vorigeVoeten, shouldStop) {
  setMovements(bot, { canDig: true, canPlace: false });
  try {
    await abortable(
      bot.pathfinder.goto(new goals.GoalBlock(start.x, vorigeVoeten, start.z)),
      shouldStop,
      () => bot.pathfinder.stop()
    );
  } catch (err) {
    Logger.warn(`Kon niet boven het volgende startpunt komen: ${err.message}`);
    // Niet fataal: zakken kan ook vanaf de plek waar hij nu staat, mineCorridor loopt daarna
    // zelf naar het begin van de strook.
  }
  setMovements(bot, { canDig: false, canPlace: false });

  if (shouldStop()) return false;
  return zakNaarLaag(bot, start.y, shouldStop);
}

async function restoreGoal(bot) {
  if (botState.lastMineData) {
    // resumeFrom: na een dood gaat hij verder waar hij gebleven was. Eerder begon hij de
    // hele tunnel opnieuw vanaf het begin, wat bij een lange gang minutenlang door al
    // uitgegraven gang lopen betekende.
    const { from, to, hoogte, breedte, label, collect, resumeFrom } = botState.lastMineData;
    Logger.info(`Tunnel hervatten vanaf cel ${resumeFrom}`);
    await mineCorridor(bot, new Vec3(from.x, from.y, from.z), new Vec3(to.x, to.y, to.z),
      { hoogte, breedte, label, collect, resumeFrom });
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

module.exports = { mineTunnel, mineCorridor, mineRoom, kamerStroken, kamerLagen, corridorCells, crossSection, chestAlcoves, placeChestInWall, storeBlocksInChest, sweepMiningDrops, isWaardevolleDrop, restoreGoal, safeDig };

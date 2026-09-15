// Gewasregister: per gewas staat hier HOE je het oogst, niet alleen DAT het een gewas is.
// De vier oogstmanieren verschillen fundamenteel — een wortel breek je en plant je terug,
// een bessenstruik mag je juist nooit breken — dus die logica hoort bij het gewas zelf en
// niet verspreid over de oogstlus.
//
// Alle blok- en itemnamen en alle state-ranges hieronder zijn geverifieerd tegen de
// 26.1-registry (prismarine-registry), niet uit het hoofd opgeschreven.

const CATEGORY = {
  // 1. Breek het volgroeide blok en plant het zaad meteen terug op dezelfde plek.
  REPLANT: 'replant',
  // 2. Breek de vrucht naast de stengel. De stengel zelf blijft ALTIJD staan.
  FRUIT: 'fruit',
  // 3. Rechtsklikken om te oogsten. Het blok wordt NOOIT gebroken.
  INTERACT: 'interact',
  // 4. Breek het tweede blok van onderen, zodat het onderste blok weer aangroeit.
  VERTICAL: 'vertical',
};

// Hoe bepalen we of een blok oogstbaar is? Deze predicaten krijgen de block-properties
// plus de max-age die uit het registry komt.
// Let op: property-waarden komen als STRING terug ('7'), behalve echte booleans.
const ripeAtMaxAge = (props, maxAge) => maxAge !== null && Number(props.age) === maxAge;
const alwaysRipe = () => true;
const isTrue = (v) => v === true || v === 'true';

/**
 * @typedef {object} CropDef
 * @property {string}   block      bloknaam in de wereld
 * @property {string}   category   een van CATEGORY
 * @property {string?}  seed       ITEM dat teruggeplant wordt (null = niet herplanten).
 *                                 Bewust gescheiden van `block`: 'wheat_seeds' is het item,
 *                                 'wheat' is het blok.
 * @property {string[]?} soil      toegestane ondergrond voor het herplanten
 * @property {'below'|'side'} placeOn  waar het zaad tegenaan geplaatst wordt
 * @property {string?}  tool       voorkeursgereedschap ('hoe'/'axe'/'sword'/null = hand)
 * @property {string[]?} stems     FRUIT: bijbehorende stengels (mogen nooit gebroken worden)
 * @property {string[]?} column    VERTICAL: blokken die tot dezelfde plant horen
 * @property {string[]?} base      VERTICAL: blokken die als voet gelden en blijven staan
 */

const CROP_LIST = [
  // ---------------------------------------------------------------- 1. STANDAARD
  { block: 'wheat', category: CATEGORY.REPLANT, seed: 'wheat_seeds', soil: ['farmland'], tool: 'hoe', ripe: ripeAtMaxAge },
  { block: 'carrots', category: CATEGORY.REPLANT, seed: 'carrot', soil: ['farmland'], tool: 'hoe', ripe: ripeAtMaxAge },
  { block: 'potatoes', category: CATEGORY.REPLANT, seed: 'potato', soil: ['farmland'], tool: 'hoe', ripe: ripeAtMaxAge },
  { block: 'beetroots', category: CATEGORY.REPLANT, seed: 'beetroot_seeds', soil: ['farmland'], tool: 'hoe', ripe: ripeAtMaxAge },
  { block: 'nether_wart', category: CATEGORY.REPLANT, seed: 'nether_wart', soil: ['soul_sand'], tool: 'hoe', ripe: ripeAtMaxAge },

  // Torchflower: het GROEIENDE blok heet torchflower_crop (age 0-1) en verandert bij
  // volgroeidheid in het blok `torchflower` (zonder age-state). Je oogst dus de bloem,
  // niet het crop-blok — daarom `alwaysRipe` plus de eis dat er farmland onder ligt,
  // wat wilde/decoratieve torchflowers buiten schot houdt.
  { block: 'torchflower', category: CATEGORY.REPLANT, seed: 'torchflower_seeds', soil: ['farmland'], tool: 'hoe', ripe: alwaysRipe },

  // Pitcher: idem, pitcher_crop (age 0-4) wordt bij volgroeidheid `pitcher_plant`.
  // Beide zijn 2 blokken hoog vanaf age 3; we mikken altijd op de ONDERSTE helft,
  // want die breken neemt de bovenste vanzelf mee.
  { block: 'pitcher_plant', category: CATEGORY.REPLANT, seed: 'pitcher_pod', soil: ['farmland'], tool: 'hoe', lowerHalfOnly: true,
    ripe: (props) => props.half === 'lower' },
  { block: 'pitcher_crop', category: CATEGORY.REPLANT, seed: 'pitcher_pod', soil: ['farmland'], tool: 'hoe', lowerHalfOnly: true,
    ripe: (props, maxAge) => props.half === 'lower' && ripeAtMaxAge(props, maxAge) },

  // Cocoa groeit tegen de ZIJKANT van een jungle log, dus herplanten gaat zijwaarts.
  { block: 'cocoa', category: CATEGORY.REPLANT, seed: 'cocoa_beans', placeOn: 'side',
    soil: ['jungle_log', 'jungle_wood', 'stripped_jungle_log', 'stripped_jungle_wood'],
    tool: 'axe', ripe: ripeAtMaxAge },

  // ---------------------------------------------------------------- 2. STENGELGEWASSEN
  // De vrucht wordt gebroken, de stengel nooit. attached_*_stem is de stengel zodra er
  // een vrucht aan vast zit; de losse *_stem (age 0-7) staat er ook vaak naast.
  { block: 'melon', category: CATEGORY.FRUIT, tool: 'axe', ripe: alwaysRipe,
    stems: ['attached_melon_stem', 'melon_stem'] },
  { block: 'pumpkin', category: CATEGORY.FRUIT, tool: 'axe', ripe: alwaysRipe,
    stems: ['attached_pumpkin_stem', 'pumpkin_stem'] },

  // ---------------------------------------------------------------- 3. INTERACTIE
  // Rechtsklikken oogst de bessen en laat de plant staan. Breken zou de plant slopen.
  { block: 'sweet_berry_bush', category: CATEGORY.INTERACT, ripe: ripeAtMaxAge },
  { block: 'cave_vines', category: CATEGORY.INTERACT, ripe: (props) => isTrue(props.berries) },
  { block: 'cave_vines_plant', category: CATEGORY.INTERACT, ripe: (props) => isTrue(props.berries) },

  // ---------------------------------------------------------------- 4. VERTICAAL
  // Breek het tweede blok van onderen; het onderste blijft staan en groeit weer aan.
  { block: 'sugar_cane', category: CATEGORY.VERTICAL, tool: null, ripe: alwaysRipe,
    column: ['sugar_cane'] },
  { block: 'cactus', category: CATEGORY.VERTICAL, tool: null, ripe: alwaysRipe,
    column: ['cactus'] },
  { block: 'bamboo', category: CATEGORY.VERTICAL, tool: 'sword', ripe: alwaysRipe,
    column: ['bamboo'], base: ['bamboo_sapling'] },
  { block: 'kelp', category: CATEGORY.VERTICAL, tool: null, ripe: alwaysRipe,
    column: ['kelp', 'kelp_plant'] },
  { block: 'kelp_plant', category: CATEGORY.VERTICAL, tool: null, ripe: alwaysRipe,
    column: ['kelp', 'kelp_plant'] },

  // ---------------------------------------------------------------- 5. SPECIAAL / FUNGI
  // Zeekomkommer groeit in trosjes van 1 t/m 4; we oogsten pas bij een volle tros en
  // zetten er eentje terug.
  { block: 'sea_pickle', category: CATEGORY.REPLANT, seed: 'sea_pickle', soil: null, tool: null,
    ripe: (props) => Number(props.pickles) === 4 },

  // Paddenstoelen en fungi hebben geen groeistadium: ze staan er of ze staan er niet.
  { block: 'brown_mushroom', category: CATEGORY.REPLANT, seed: 'brown_mushroom', soil: null, tool: null, ripe: alwaysRipe },
  { block: 'red_mushroom', category: CATEGORY.REPLANT, seed: 'red_mushroom', soil: null, tool: null, ripe: alwaysRipe },
  { block: 'crimson_fungus', category: CATEGORY.REPLANT, seed: 'crimson_fungus', tool: null, ripe: alwaysRipe,
    soil: ['crimson_nylium', 'warped_nylium', 'soul_soil', 'netherrack', 'mycelium', 'podzol'] },
  { block: 'warped_fungus', category: CATEGORY.REPLANT, seed: 'warped_fungus', tool: null, ripe: alwaysRipe,
    soil: ['warped_nylium', 'crimson_nylium', 'soul_soil', 'netherrack', 'mycelium', 'podzol'] },

  // Chorus: alleen de BLOEM wordt geoogst. Bij age 5 is de bloem uitgegroeid en groeit
  // hij niet verder; hem weghalen stopt de groei en levert een chorus_flower op.
  // De chorus_plant-stengels blijven staan — die breken sloopt de hele boom.
  { block: 'chorus_flower', category: CATEGORY.REPLANT, seed: 'chorus_flower', soil: ['end_stone'],
    tool: 'axe', ripe: ripeAtMaxAge },
];

const CROPS_BY_BLOCK = Object.fromEntries(CROP_LIST.map(c => [c.block, c]));

// Blokken die de bot onder GEEN ENKELE omstandigheid mag breken. Dit is de harde grens
// achter de categorie-logica: ook als er ergens een taak verkeerd wordt opgebouwd, weigert
// harvest() een blok uit deze lijst.
const NEVER_BREAK = new Set([
  // stengels (categorie 2)
  'melon_stem', 'pumpkin_stem', 'attached_melon_stem', 'attached_pumpkin_stem',
  // interactiegewassen (categorie 3)
  'sweet_berry_bush', 'cave_vines', 'cave_vines_plant',
  // voet van verticale planten (categorie 4)
  'bamboo_sapling',
  // stengels van chorus: alleen de bloem mag weg
  'chorus_plant',
  // ondergronden
  'farmland', 'soul_sand', 'soul_soil', 'end_stone', 'netherrack',
  'crimson_nylium', 'warped_nylium', 'mycelium', 'podzol', 'dirt', 'grass_block',
  'sand', 'red_sand', 'jungle_log', 'jungle_wood', 'stripped_jungle_log', 'stripped_jungle_wood',
  'water', 'moss_block',
  // het groeistadium van torchflower/pitcher: nog niet oogstrijp, laten staan
  'torchflower_crop',
]);

// Blokken die de pathfinder nooit mag slopen (vangnet bovenop canDig=false).
const PROTECTED_BLOCKS = [
  ...new Set([...NEVER_BREAK, ...CROP_LIST.map(c => c.block)]),
];

// Items die een oogstronde kan opleveren. Alleen deze worden weggegeven.
const YIELD_ITEMS = new Set([
  'wheat', 'wheat_seeds', 'beetroot', 'beetroot_seeds', 'carrot', 'potato', 'poisonous_potato',
  'torchflower', 'torchflower_seeds', 'pitcher_plant', 'pitcher_pod',
  'nether_wart', 'cocoa_beans',
  'melon', 'melon_slice', 'melon_seeds', 'pumpkin', 'pumpkin_seeds',
  'sweet_berries', 'glow_berries',
  'sugar_cane', 'cactus', 'bamboo', 'kelp', 'dried_kelp',
  'sea_pickle', 'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus',
  'chorus_fruit', 'popped_chorus_fruit', 'chorus_flower',
]);

// Zaad-items waarvan altijd 1 stack achterblijft, zodat herplanten kan doorgaan.
const SEED_ITEMS = new Set(
  CROP_LIST.filter(c => c.seed).map(c => c.seed)
);

module.exports = {
  CATEGORY,
  CROP_LIST,
  CROPS_BY_BLOCK,
  NEVER_BREAK,
  PROTECTED_BLOCKS,
  YIELD_ITEMS,
  SEED_ITEMS,
};

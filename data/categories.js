/**
 * Categorieënwoordenboek voor het sorteren.
 *
 * Het idee: een stenen zwaard en een gouden zwaard horen bij elkaar, ook al heten ze anders.
 * De categorie gaat dus over WAT het ding is, niet waar het van gemaakt is.
 *
 * De regels worden van boven naar beneden afgelopen, de eerste treffer wint. Die volgorde is
 * geen detail: 'diamond_pickaxe' eindigt óók op 'axe', dus pikhouwelen moeten vóór bijlen
 * staan. Hetzelfde geldt voor gouden appels (voedsel, niet metaal) en voor alles wat op
 * '_block' eindigt.
 *
 * Items die door geen enkele regel gedekt worden krijgen bewust GEEN categorie. Ze worden dan
 * alleen op exacte naam gesorteerd. Een restcategorie "overig" zou juist de verkeerde kant op
 * werken: dan belandt elk onbekend item in de eerste kist waar toevallig ook iets onbekends in ligt.
 */

const rules = [];
function rule(categorie, test) {
  rules.push({ categorie, test: typeof test === 'function' ? test : (name) => test.test(name) });
}

// --- gereedschap: per soort, over alle materialen heen -----------------------
rule('pikhouwelen', /_pickaxe$/);
rule('bijlen', /_axe$/);            // moet ná pikhouwelen: 'stone_pickaxe' eindigt ook op 'axe'
rule('schoppen', /_shovel$/);
rule('schoffels', /_hoe$/);
rule('zwaarden', /_sword$|^trident$|^mace$/);
rule('scharen_en_gereedschap', /^shears$|^flint_and_steel$|^fishing_rod$|^brush$|^spyglass$|^compass$|^clock$|^lead$|^name_tag$/);

// --- wapens en munitie ------------------------------------------------------
rule('bogen_en_pijlen', /^bow$|^crossbow$|arrow$|^firework_rocket$/);

// --- uitrusting -------------------------------------------------------------
rule('harnas', /_helmet$|_chestplate$|_leggings$|_boots$|^elytra$|_horse_armor$|^wolf_armor$/);
rule('schilden', /^shield$/);

// --- eten: via de spel-data zelf, niet via een eigen lijst -------------------
// Rot vlees en spinnenogen staan hier expres bovenaan: het spel rekent ze tot voedsel, maar
// niemand wil ze in zijn etenskist. Ze horen bij de mobdrops.
rule('mobdrops', /^rotten_flesh$|^spider_eye$/);
// Staat vóór de grondstoffen, anders wordt een gouden appel als metaal weggezet.
rule('voedsel', (name, registry) => !!registry?.foodsByName?.[name]);

// --- landbouw ---------------------------------------------------------------
rule('zaden_en_gewassen', /_seeds$|^wheat$|^beetroot$|^carrot$|^potato$|^nether_wart$|^cocoa_beans$|^sugar_cane$|^bamboo$|^kelp$|^pitcher_pod$|^sea_pickle$|^bone_meal$/);

// --- hout -------------------------------------------------------------------
rule('stammen', /_log$|_wood$|_stem$|_hyphae$/);
rule('planken', /_planks$/);
rule('houtbouw', /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(slab|stairs|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|hanging_sign|boat|chest_boat|raft)$/);

// --- steen en bouwblokken ---------------------------------------------------
rule('erts', /_ore$|^raw_(iron|gold|copper)(_block)?$|^ancient_debris$/);
// Samengeperste grondstoffen: het opslagblok hoort bij het opslagblok, niet bij los erts.
rule('grondstofblokken', /^(coal|iron|gold|diamond|emerald|netherite|lapis|amethyst|copper|quartz|bone|dried_kelp|hay|slime|honey)_block$|^block_of_/);
// Koperbouw met al zijn verweringsstadia: gewoon, exposed, weathered, oxidized en gewaxt.
rule('koper', /^(waxed_)?(exposed_|weathered_|oxidized_)?(chiseled_|cut_|copper_)?(copper|grate|bulb|door|trapdoor|golem_statue)$|copper(_grate|_bulb|_door|_trapdoor)$/);
rule('metaal_en_edelsteen', /_ingot$|_nugget$|^diamond$|^emerald$|^lapis_lazuli$|^quartz$|^coal$|^charcoal$|^amethyst_shard$|^netherite_scrap$|^copper_(ingot|nugget)$/);
rule('steen', /^(stone|cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|tuff|calcite|basalt|smooth_basalt|blackstone|dripstone_block|sandstone|red_sandstone|prismarine|end_stone|netherrack|nether_bricks?|quartz_block|purpur_block|obsidian|magma_block)$|^(polished|smooth|chiseled|cracked|mossy|cut)_/);
rule('steenbouw', /_(slab|stairs|wall|bricks|brick|pillar|tiles)$/);
rule('aarde_en_zand', /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|farmland|dirt_path|mud|clay|sand|red_sand|gravel|soul_sand|soul_soil|snow|snow_block|ice|packed_ice|blue_ice|moss_block)$/);

// --- decoratie --------------------------------------------------------------
rule('wol_en_tapijt', /_wool$|_carpet$|^wool$/);
rule('bedden', /_bed$/);
rule('kleurstoffen', /_dye$|^ink_sac$|^glow_ink_sac$/);
rule('glas', /glass$|glass_pane$/);
rule('terracotta_en_beton', /terracotta$|^.*_concrete(_powder)?$/);
rule('kaarsen_en_licht', /^candle$|_candle$|^torch$|^soul_torch$|^lantern$|^soul_lantern$|^glowstone$|^sea_lantern$|^shroomlight$|^redstone_lamp$|^end_rod$|^amethyst_cluster$/);
rule('banieren_en_vlaggen', /_banner$|^banner_pattern$|_banner_pattern$/);

// --- redstone ---------------------------------------------------------------
rule('redstone', /^redstone(_(block|torch))?$|^repeater$|^comparator$|^piston$|^sticky_piston$|^observer$|^hopper$|^dropper$|^dispenser$|^lever$|^tripwire_hook$|^daylight_detector$|^target$|^note_block$|^slime_block$|^honey_block$|^rail$|_rail$|^minecart$|_minecart$/);

// --- planten ----------------------------------------------------------------
rule('planten', /_sapling$|_leaves$|^vine$|_mushroom$|_fungus$|_roots$|_coral(_block|_fan)?$|^fern$|^large_fern$|^grass$|^tall_grass$|^dead_bush$|^cactus$|^lily_pad$|^moss_carpet$|^azalea$|^flowering_azalea$|^big_dripleaf$|^small_dripleaf$|^spore_blossom$|^hanging_roots$|^glow_lichen$|^sculk.*$/);
rule('bloemen', /^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torchflower|pink_petals|wildflowers|open_eyeblossom|closed_eyeblossom|bush|firefly_bush)$|_tulip$/);

// --- brouwen en magie -------------------------------------------------------
rule('drankjes', /^potion$|^splash_potion$|^lingering_potion$|^glass_bottle$|^experience_bottle$|^dragon_breath$/);
rule('brouw_ingredienten', /^blaze_powder$|^nether_wart$|^fermented_spider_eye$|^magma_cream$|^ghast_tear$|^glistering_melon_slice$|^golden_carrot$|^rabbit_foot$|^phantom_membrane$|^turtle_scute$|^sugar$|^redstone$|^gunpowder$/);
rule('eindeloos_spul', /^ender_pearl$|^ender_eye$|^chorus_fruit$|^popped_chorus_fruit$|^shulker_shell$|^dragon_egg$/);

// --- mobdrops ---------------------------------------------------------------
rule('mobdrops', /^rotten_flesh$|^bone$|^string$|^spider_eye$|^slime_ball$|^leather$|^feather$|^prismarine_shard$|^prismarine_crystals$|^nautilus_shell$|^heart_of_the_sea$|^blaze_rod$|^wither_skeleton_skull$|^totem_of_undying$|^rabbit_hide$|^honeycomb$|^armadillo_scute$/);

// --- overig maar wel herkenbaar ---------------------------------------------
rule('muziekschijven', /^music_disc_|^disc_fragment_/);
rule('boeken_en_papier', /^book$|^written_book$|^writable_book$|^enchanted_book$|^paper$|^map$|^filled_map$|^bookshelf$|^chiseled_bookshelf$/);
rule('vervoer', /^saddle$|^carrot_on_a_stick$|^warped_fungus_on_a_stick$|_boat$|^boat$/);
rule('kisten_en_opslag', /chest$|^barrel$|shulker_box$|^furnace$|^blast_furnace$|^smoker$|^crafting_table$|^anvil$|^chipped_anvil$|^damaged_anvil$|^enchanting_table$|^brewing_stand$|^cauldron$|^composter$|^grindstone$|^smithing_table$|^stonecutter$|^loom$|^cartography_table$|^fletching_table$|^lectern$/);
rule('emmers', /bucket$/);
rule('eieren_en_spawn', /_spawn_egg$|^egg$/);

/**
 * De categorie van een item, of null als we het niet weten.
 * @param {object} registry bot.registry — nodig voor de voedselcontrole
 * @param {string} itemName
 * @returns {string|null}
 */
function categoryOf(registry, itemName) {
  if (!itemName) return null;
  for (const { categorie, test } of rules) {
    if (test(itemName, registry)) return categorie;
  }
  return null;
}

/** Alle categorienamen, voor tests en voor !categorie. */
function allCategories() {
  return [...new Set(rules.map(r => r.categorie))];
}

module.exports = { categoryOf, allCategories };

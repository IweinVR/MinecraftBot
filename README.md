# MinecraftBot README

**Beschrijving**
De MinecraftBot is een modulair geautomatiseerd script, gebouwd in Node.js en aangedreven door de Mineflayer-library. De bot is ontworpen om diverse in-game processen te optimaliseren en volledig te automatiseren. De architectuur is specifiek ingericht voor complexe systemen, waaronder efficiënte landbouw (zoals crop optimalisaties in Hypixel Skyblock), geavanceerde inventaris-sortering en geautomatiseerde handelssystemen.

## Functionaliteiten (Features)

De core-logica van de bot is opgesplitst in onafhankelijke modules binnen de `features/` directory. Elke module is verantwoordelijk voor een specifieke in-game taak:

### 🧬 Breeding (`features/breeding.js`)

Deze module is verantwoordelijk voor geautomatiseerd fokken, maar gaat veel verder dan simpelweg voedsel uitdelen. Het houdt nauwkeurig rekening met Vanilla Minecraft-mechanics en de in-game economie om voedselverspilling te voorkomen.

**Hoe te gebruiken in-game**
* **Handmatig:** Typ `!breed` in de Minecraft-chat om de bot eenmalig alle dieren in de buurt te laten voeren.
* **Stoppen:** Typ `!stop` in de chat om het fokken direct af te breken.
* **Automatisch:** Je hoeft dit niet handmatig te doen als de bot aan het boeren is; de bot voert de fok-ronde automatisch één keer per oogstronde uit tijdens de farming-cyclus.

**Slimme Beveiligingen (Fail-safes)**
* **Geen voedselverspilling:** De Minecraft-server geeft niet aan of een dier al in *love mode* is of nog in een afkoelperiode zit. De bot lost dit op door een interne lijst (`gevoerd`) bij te houden; elk dier wordt per ronde maximaal één keer gevoerd.
* **Zaad- en Voedselreserve (`spareCount`):** Items zoals wortels, aardappelen en zaden zijn zowel veevoer als plantgoed. De bot berekent dynamisch de voorraad en trekt de benodigde landbouwreserve (`FARM.keepSeedCount` + `BREED.keepFoodCount`) hiervan af, zodat akkers nooit per ongeluk aan dieren worden gevoerd.
* **Koppel-afstandslogica (`makePairs`):** Twee dieren die te ver uit elkaar staan (meer dan 8 blokken) kunnen elkaar in Vanilla Minecraft niet bereiken, zelfs niet in *love mode*. De bot berekent vooraf via `distanceTo` of partners dicht genoeg bij elkaar staan, om zinloos voeren te vermijden.

**Stap-voor-stap Werking**
1. **Scannen en Filteren (`scanAnimals`):** Zoekt alle dieren binnen de ingestelde `scanRadius` en groepeert deze per soort.
2. **Metadata Uitlezen:** De bot leest dynamisch via `bot.registry` de entiteit-metadata uit (onafhankelijk van de Minecraft-versie). Hierdoor filtert hij feilloos baby-dieren en ongetemde wolven of paarden eruit.
3. **Koppels Maken (`makePairs`):** Volwassen, geldige dieren worden logisch in setjes van twee gezet op basis van hun onderlinge afstand.
4. **Navigatie & Voeren (`approachAnimal` & `feedAnimal`):** Omdat dieren weglopen, stelt de bot niet eenmalig een pad in, maar controleert hij de actuele locatie continu uit `bot.entities`. Zodra het dier binnen `reachDistance` is, pakt de bot het juiste voedsel en voert hij een interactie (`activateEntity`) uit.
5. **Veilige Verplaatsing (`breedMovements`):** Parkour (springen) wordt automatisch uitgeschakeld om te voorkomen dat de bot *farmland* vertrapt tot normale aarde terwijl hij achter dieren aan rent.

**Uitzonderingen & Speciale Mechanieken**
De interne `BREEDABLE` dictionary bevat unieke regels per diersoort:
* **Wolven (`needsFullHp`):** Een gewonde wolf eet vlees om te genezen in plaats van te paren. De bot controleert eerst of de health minimaal 20 is.
* **Panda's (`pandaHasBamboo`):** Panda's vereisen de aanwezigheid van bamboe. Een custom `extra`-functie scant via `bot.findBlocks` of er minimaal 8 bamboeblokken binnen 5 blokken afstand van de panda staan.

*   **Chat (`chat.js`)**: Verwerkt inkomende chatberichten, filtert belangrijke server-informatie en regelt geautomatiseerde reacties.
*   **Combat (`combat.js`)**: Beheert PVE- of PVP-gevechtshandelingen, inclusief het detecteren van vijandige mobs en het positioneren voor aanvallen.
*   **Commands (`commands.js`)**: Een systeem voor het verwerken van in-game of console-commando's om de bot direct aan te sturen (bijvoorbeeld voor het starten of stoppen van specifieke taken).
*   **Courier (`courier.js`)**: Logistieke module voor het verplaatsen van items. Ideaal voor het transporteren van grondstoffen tussen verschillende opslaglocaties of spelers.
*   **Farming (`farming.js`)**: Hoogefficiënte landbouwautomatisering voor het planten en oogsten van gewassen. Werkt nauw samen met de gedefinieerde data in de `crops.js` structuur.
*   **Fishing (`fishing.js`)**: Bevat de logica voor automatisch vissen, inclusief het detecteren van dobber-bewegingen en het binnenhalen van de vangst.
*   **Mining (`mining.js`)**: Pathfinding en breek-logica voor het automatisch delven van blokken, ertsen en het verzamelen van materialen.
*   **Sorting (`sorting.js`)**: Een geavanceerd inventaris- en kistenbeheersysteem dat items automatisch sorteert op basis van de categorieën gedefinieerd in `categories.js`.
*   **Toolsmith (`toolsmith.js`)**: Bewaakt de duurzaamheid van gereedschappen en zorgt voor het automatisch wisselen, repareren of craften van nieuwe tools wanneer deze dreigen te breken.
*   **Trading (`trading.js`)**: Automatiseert handelstransacties. Dit faciliteert interacties met standard villagers (villager trading bots) of externe economische systemen zoals de Bazaar.

## Datastructuren

De `data/` directory bevat statische informatie en parameters die door de features worden geraadpleegd:

*   **`categories.js`**: Definieert de groepering van items (bijv. mineralen, landbouwproducten, wapens) ten behoeve van het sorteersysteem.
*   **`crops.js`**: Bevat berekeningen, groeitijden en hitbox-data voor verschillende soorten landbouwgewassen.
*   **`songs.js`**: Data voor muzikale functionaliteiten.

## Onderliggende Architectuur & Libraries

Het project is robuust opgezet met externe afhankelijkheden en interne helper-scripts:

*   **Configuratie**: De algemene instellingen, servergegevens en bot-parameters worden beheerd vanuit `config.js`.
*   **Lib Directory**: Bevat gedeelde technische logica. `containers.js`
*   **Node Modules**: De bot leunt zwaar op externe npm-pakketten. Opvallende afhankelijkheden zijn onder andere `@nxg-org/mineflayer-util-plugin` voor uitgebreide Mineflayer utilities, `protodef-validator` voor protocol data, en `@azure/msal-node` voor de authenticatie via Microsoft-accounts, wat tegenwoordig vereist is voor Minecraft.

## Installatie

Om de bot te laten draaien, dienen de Node.js afhankelijkheden geïnstalleerd te worden. Start hiervoor het volgende commando in de hoofdmap:

```bash
npm install

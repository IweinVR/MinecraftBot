MinecraftBot README

Beschrijving
De MinecraftBot is een modulair geautomatiseerd script, gebouwd in Node.js en aangedreven door de Mineflayer-library. De bot is ontworpen om diverse in-game processen te optimaliseren en volledig te automatiseren. De architectuur is specifiek ingericht voor complexe systemen, waaronder efficiënte landbouw (zoals crop optimalisaties in Hypixel Skyblock), geavanceerde inventaris-sortering en geautomatiseerde handelssystemen.

Functionaliteiten (Features)

De core-logica van de bot is opgesplitst in onafhankelijke modules binnen de features/ directory. Elke module is verantwoordelijk voor een specifieke in-game taak:

Breeding (breeding.js): Automatiseert het fokken van dieren door automatisch het juiste voedsel toe te dienen aan entiteiten in de omgeving.

Chat (chat.js): Verwerkt inkomende chatberichten, filtert belangrijke server-informatie en regelt geautomatiseerde reacties.

Combat (combat.js): Beheert PVE- of PVP-gevechtshandelingen, inclusief het detecteren van vijandige mobs en het positioneren voor aanvallen.

Commands (commands.js): Een systeem voor het verwerken van in-game of console-commando's om de bot direct aan te sturen (bijvoorbeeld voor het starten of stoppen van specifieke taken).

Courier (courier.js): Logistieke module voor het verplaatsen van items. Ideaal voor het transporteren van grondstoffen tussen verschillende opslaglocaties of spelers.

Farming (farming.js): Hoogefficiënte landbouwautomatisering voor het planten en oogsten van gewassen. Werkt nauw samen met de gedefinieerde data in de crops.js structuur.

Fishing (fishing.js): Bevat de logica voor automatisch vissen, inclusief het detecteren van dobber-bewegingen en het binnenhalen van de vangst.

Mining (mining.js): Pathfinding en breek-logica voor het automatisch delven van blokken, ertsen en het verzamelen van materialen.

Sorting (sorting.js): Een geavanceerd inventaris- en kistenbeheersysteem dat items automatisch sorteert op basis van de categorieën gedefinieerd in categories.js.

Toolsmith (toolsmith.js): Bewaakt de duurzaamheid van gereedschappen en zorgt voor het automatisch wisselen, repareren of craften van nieuwe tools wanneer deze dreigen te breken.

Trading (trading.js): Automatiseert handelstransacties. Dit faciliteert interacties met standard villagers (villager trading bots) of externe economische systemen zoals de Bazaar.

Datastructuren

De data/ directory bevat statische informatie en parameters die door de features worden geraadpleegd:

categories.js: Definieert de groepering van items (bijv. mineralen, landbouwproducten, wapens) ten behoeve van het sorteersysteem.

crops.js: Bevat berekeningen, groeitijden en hitbox-data voor verschillende soorten landbouwgewassen.

songs.js: Data voor muzikale functionaliteiten, waarschijnlijk gebruikt voor het afspelen van Note Block Studio (NBS) bestanden of waarschuwingsgeluiden.

Onderliggende Architectuur & Libraries

Het project is robuust opgezet met externe afhankelijkheden en interne helper-scripts:

Configuratie: De algemene instellingen, servergegevens en bot-parameters worden beheerd vanuit config.js.

Lib Directory: Bevat gedeelde technische logica. containers.js regelt waarschijnlijk het openen en uitlezen van kisten en UI-schermen, terwijl storage.js lokale data-opslaan of caching afhandelt.

Node Modules: De bot leunt zwaar op externe npm-pakketten. Opvallende afhankelijkheden zijn onder andere @nxg-org/mineflayer-util-plugin voor uitgebreide Mineflayer utilities, protodef-validator voor protocol data, en @azure/msal-node voor de authenticatie via Microsoft-accounts, wat tegenwoordig vereist is voor Minecraft.

Installatie

Om de bot te laten draaien, dienen de Node.js afhankelijkheden geïnstalleerd te worden. Start hiervoor het volgende commando in de hoofdmap:

npm install


Vervolgens kan de bot gestart worden via de hoofd-entrypoint:

node Index.js

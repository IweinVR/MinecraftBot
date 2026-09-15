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

### 💬 Chat & Reacties (`features/chat.js`)

Deze module zorgt voor natuurlijke, automatische reacties op in-game chatberichten. Het scant inkomende chatberichten op specifieke trefwoorden met behulp van RegEx (reguliere expressies) en voert vervolgens acties uit. Dit varieert van een simpele begroeting tot het starten van een gevecht of het zingen van een liedje.

**Hoe te gebruiken in-game**
Je hoeft voor deze feature géén commando's met een `!` te gebruiken. Typ simpelweg in de gewone chat:
* **Socialiseren:** Zeg "hallo", "doei", "hoe gaat het" of "goeie bot" en de bot reageert op de speler.
* **Informatie opvragen:** Typ "inventory" of "hp" in een zin om direct de levenspunten, honger of inventarisstatus van de bot te laten rapporteren.
* **Zingen:** Typ het woord "zing" of "muziek". De bot kiest een willekeurig liedje uit het repertoire (`songs.js`) en zingt dit regel voor regel in de chat.
* **Duelleren:** Typ "vecht tegen mij" en de bot triggert direct de `fightPlayer` functie uit de combat-module voor een duel.
* **Easter Eggs:** Noem de naam "Iwein", "Emperor" of "Solaris" om de maker te eren ("ALL HEIL THE EMPEROR SOLARIS").

**Slimme Beveiligingen (Fail-safes)**
* **Commando-voorrang (Priority):** De module weigert direct alle berichten die met een uitroepteken (`!`) beginnen. Dit voorkomt conflicten. Zonder deze regel zou een commando als `!follow Iwein` onbedoeld de "Iwein"-chat-trigger activeren, waardoor het daadwerkelijke volg-commando nooit zou worden uitgevoerd.
* **Zang-Slot (Anti-Spam):** Omdat zingen tijd kost, is er een interne `isSinging` lock ingebouwd. Als spelers in de chat spammen met het woord "zing", voorkomt dit dat de bot tientallen liedjes tegelijk – en volledig door elkaar heen – gaat spuien.
* **Zelf-Uitsluiting:** De bot negeert berichten die hij zelf heeft gestuurd (`username === bot.username`). Dit is een cruciale fail-safe om oneindige praat-loops (waarbij de bot op zijn eigen antwoord reageert) te voorkomen.

**Stap-voor-stap Werking**
1. **Validatie:** Zodra er een chatbericht binnenkomt, kijkt `handleChatReactions` eerst wie het stuurt en of het geen expliciet commando (`!`) is. 
2. **Patroonherkenning:** De bot loopt de `REACTIONS` array van boven naar beneden af. Dit is een strakke hiërarchie: **de eerste match wint altijd**. 
3. **Uitvoering & Feedback:** Als een patroon (zoals `/\b(zing|zingen|muziek)\b/i`) matcht, voert de bot de gekoppelde `reply()` functie uit. Hierna wordt `true` teruggegeven aan het hoofdscript, zodat deze weet dat het bericht is afgehandeld en er geen verdere logica (zoals command-parsing) meer op losgelaten hoeft te worden.

### ⚔️ Combat & Survival (`features/combat.js`)

Deze module beheert alles wat te maken heeft met gevaar, verdediging en overleving. Het regelt gevechten met spelers en monsters, het ontwijken van de dood (bijvoorbeeld via MLG-water), vluchtgedrag en zelfs gecontroleerde zelfmoord.

**Hoe te gebruiken in-game**
* **Vechten (`!vecht` of chat "vecht tegen mij"):** De bot pakt zijn beste wapen en start een duel via de `mineflayer-pvp` plugin.
* **Slapen (`!bed`):** De bot zoekt het dichtstbijzijnde bed en stelt zijn spawnpoint in (werkt alleen 's nachts of bij onweer).
* **Zelfmoord (`!die`):** De bot zoekt het dichtstbijzijnde monster, lava of vuur op om zichzelf te elimineren en terug te keren naar spawn.
* **Automatisch:** De bot voert automatisch de 'MLG water bucket' truc uit bij diepe vallen, draait zich om naar spelers die hem slaan, en vlucht bij lage levenspunten.

**Slimme Beveiligingen (Fail-safes)**
* **Omgevingsschade-detectie:** De bot draait zich alleen om (`faceAttacker`) als de schade écht door een entiteit is aangericht. Hierdoor draait hij zich niet meer verward naar een willekeurige speler als hij toevallig zelf in de lava stapt.
* **MLG Bucket Precisie:** Bij het opvangen van een val gebruikt de bot `findItemExact`. Hierdoor pakt hij 100% zeker een lege emmer of wateremmer, en plaatst hij niet per ongeluk een *lava_bucket* omdat de zoekopdracht deels overeenkwam.
* **Wapen-Rangschikking:** De bot berekent dynamisch een wapenscore (`weaponScore`) inclusief koperen gereedschap. Omdat *mineflayer-pvp* altijd de volledige cooldown afwacht, kiest de bot bewust liever een bijl (hoge schade per klap) dan een zwaard.
* **Anti-Griefing na Gevecht:** De PVP-plugin zet intern opties zoals blokken breken (`canDig`) aan. Na het gevecht forceert deze module de instellingen direct weer terug, zodat de bot je basis niet sloopt.
* **Bed Validatie:** Omdat een bed uit twee blokken bestaat (hoofd en voet), voorkomt de bot vastlopers door niet blind op het blok te klikken, maar de robuuste `bot.sleep()` functie te gebruiken die rekening houdt met de dag/nacht-cyclus en de juiste bed-helft.

**Stap-voor-stap Werking**
1. **Vluchtgedrag (`fleeFromDanger`):** Als de bot onder een bepaalde HP-grens komt, rekent hij de vector (richting) van het gevaar uit. Hij rent exact de andere kant op, stopt tijdelijk zijn huidige taak, en pakt deze na ontsnapping (zoals een speler blijven volgen) weer feilloos op.
2. **Gecontroleerde Zelfmoord (`killBot`):** De bot zoekt eerst vijanden om uit te lokken. Werkt dat niet? Dan zoekt hij vuur of lava. Omdat de pathfinder geprogrammeerd is om *nooit* in lava te lopen, wordt de pathfinder op het allerlaatste moment uitgeschakeld (`walkInto`). De bot forceert dan handmatig de *forward* en *sprint* controls om het vuur in te rennen.

### ⌨️ Commando's & Routing (`features/commands.js`)

Deze module fungeert als het zenuwstelsel van de bot. Het ontvangt alle expliciete chatcommando's (die beginnen met een `!`), interpreteert eventuele coördinaten of extra argumenten via reguliere expressies (Regex) en activeert vervolgens de juiste scripts uit de andere modules.

**Hoe te gebruiken in-game**
Alle commando's vereisen een uitroepteken (`!`) vooraf. Een kleine greep uit de mogelijkheden:
* **Navigatie:** `!kom`, `!goto <x> <y> <z>`, `!follow <speler>` om de bot te verplaatsen. Voeg `allow` toe (bijv. `!komallow`) als hij blokken mag breken op de route.
* **Tunnels & Delven:** `!tunnel naar mij`, `!tunnel noord 20` of `!collect <blok> <aantal>`. Voor tunnels kun je optioneel breedte en hoogte toevoegen (bijv. `!tunnel noord 20 3 3`).
* **Noodrem:** Typ `!stop` in de chat. Dit is de ultieme noodrem die direct álle huidige acties van de bot afbreekt.
* **Informatie:** `!help` toont een lijst met alle commando's. `!pos` rapporteert de huidige locatie en inventarisstatus in de chat.
* **Gedelegeerde acties:** Alle functies uit andere modules activeer je hier (bijv. `!farm`, `!sort`, `!vis`, `!trade`, `!maak <item>`, `!haal <item>`).

**Slimme Beveiligingen (Fail-safes)**
* **Crash Preventie (Prototype-check):** Bij het uitlezen van argumentloze commando's controleert de code veilig via `hasOwnProperty`. Dit voorkomt dat een grapjas de bot laat crashen door JavaScript-systeemwoorden zoals `!__proto__` of `!constructor` in de chat te typen.
* **De Absolute Noodrem (`!stop`):** Deze functie zet niet alleen alle vlaggen op de achtergrond uit, maar stopt ook fysiek direct het graaf-proces (`bot.stopDigging()`) en leegt de besturing (`clearControlStates`). Dit zorgt dat de bot *onmiddellijk* stilstaat en niet tergend langzaam eerst zijn blokje afbreekt.
* **Follow-Tokens tegen Overbelasting:** Elke keer als `!follow` wordt gebruikt, genereert de code een uniek token (`Symbol`). Dit voorkomt dat er meerdere loop-functies op de achtergrond opstapelen (waardoor de bot in de war raakt) als je het commando per ongeluk twee keer typt.
* **Failsafe Status Herstel:** Acties die instellingen veranderen (zoals het tijdelijk toestaan van blokken breken bij `!komallow`) worden via een `finally`-blok altijd weer netjes teruggezet. Zelfs als de bot onderweg vastloopt of een error krijgt, sloopt hij daarna niet per ongeluk je basis.
* **Tunnel Precisie & Yaw-fix:** Vroeger groef de bot vaak de verkeerde kant op omdat de "kijkrichting" (yaw) soms ongelukkig werd afgerond. Dit is gefixt: commando's vereisen nu harde doelen (coördinaten of "naar mij"), óf de bot meldt exact in de chat welke richting hij heeft gekozen (bij `!tunnel hier`), zodat eventuele afrondingsfouten direct opvallen.
* **Anti-Vastloop Limiet (`walkToTarget`):** Bewegingen die de pathfinder omzeilen hebben een ingebouwde stap-limiet (`maxSteps`). Dit voorkomt dat de bot voor eeuwig in een hoekje blijft rennen als hij de bestemming nét niet kan bereiken.

**Stap-voor-stap Werking**
1. **Directe Match:** Zodra een bericht begint met `!`, kijkt het script eerst of het commando exact overeenkomt met een commando zonder argumenten (zoals `!stop` of `!farm`).
2. **Regex Parsing:** Als er extra tekst achter staat (zoals `!tunnel noord 20`), valt het door naar de Regex-filters. Deze filters halen automatisch de nummers en woorden eruit en zetten deze om naar bruikbare variabelen (coördinaten, spelernamen, afmetingen of items).
3. **Delegatie & Foutafhandeling:** Het commando roept asynchroon (via Promises) de juiste functie uit de betreffende map aan. Eventuele fouten binnenin die functies (`.catch`) worden netjes opgevangen. Hierdoor crasht het hele Node.js proces niet, maar verschijnt er gewoon een foutmelding in de chat.

### 📦 Koerier & Voorraadbeheer (`features/courier.js`)

Deze module werkt als het omgekeerde van het sorteersysteem. De bot fungeert als logistieke koerier: hij zoekt in zijn opgebouwde geheugen op waar een specifiek item ligt, haalt het uit de juiste kist en komt het netjes bij de speler afleveren.

**Hoe te gebruiken in-game**
* **Ophalen:** Typ `!haal <item>` of `!haal <aantal> <item>` (bijv. `!haal 64 cobblestone`). De bot pakt de spullen uit de opslag en gooit het voor je neer. Geef je geen aantal op? Dan pakt hij standaard een volle stack.
* **Zoeken:** Typ `!waar <item>` om in de chat de exacte coördinaten te zien van de kisten waar dit item ligt, zonder dat de bot ernaartoe loopt.
* **Indexeren:** Typ `!index` om de bot handmatig alle kisten in de buurt te laten scannen zodat hij zijn geheugen (de index) vernieuwt.
* **Stoppen:** Typ `!stophaal` of de algemene `!stop` om de bezorging direct te annuleren.

**Slimme Beveiligingen (Fail-safes)**
* **Zelfherstellend Geheugen:** Het zoeken kost nauwelijks tijd omdat de bot een cache-index (`lib/storage.js`) gebruikt. Als een speler stiekem een kist heeft leeggehaald, merkt de bot dit bij het openen. Hij werkt dan direct zijn index bij en zoekt naadloos verder in de volgende kist.
* **Slimme Woordherkenning (`resolveItem`):** Je kunt gedeeltelijke namen typen (zoals "cobble"). Levert dit meerdere opties op? Dan kijkt de bot eerst naar wat er *daadwerkelijk* in de opslag ligt om de meest logische keuze te maken (hij kiest dan `cobblestone` in plaats van `cobblestone_stairs`).
* **Inventaris-limiet:** De bot stopt met het leeghalen van kisten zodra zijn eigen inventaris vol dreigt te raken (`minFreeSlots`), zodat er geen items onbedoeld op de grond vallen bij de kist.
* **Veiligheidsrestricties (`courierMovements`):** Net als bij het fokken mag de bot tijdens het bezorgen géén blokken breken of plaatsen, en niet sprint-springen (geen parkour). Dit voorkomt schade aan de basis en farmland.
* **Afstandsoptimalisatie:** Als een item in meerdere kisten ligt, rekent de bot de afstand (`distanceTo`) uit en bezoekt hij altijd de kist die het dichtstbij is.

**Stap-voor-stap Werking**
1. **Vertalen & Caching:** De bot vertaalt de zoekterm naar een exacte Minecraft-itemnaam. Vervolgens checkt hij de index. Is de index helemaal leeg? Dan scant hij proactief eerst alle kisten in de buurt (`buildIndex`).
2. **Verzamelen (`takeFromChest`):** De bot navigeert naar de kist, opent de GUI (`openChest`), haalt exact het benodigde aantal items eruit en updatet tegelijkertijd zijn interne geheugen voor die kist.
3. **Afleveren (`handOver`):** Na het verzamelen zoekt hij de speler op die de aanvraag deed (`findNearestEntity` of via de spelerslijst), navigeert ernaartoe en gooit de items voor diens voeten op de grond (`bot.toss`).

### 🌾 Landbouw & Oogsten (`features/farming.js`)

Deze module transformeert de bot in een volautomatische boer. Het systeem is extreem flexibel doordat de regels voor het oogsten (wanneer is iets rijp, hoe moet het gebroken worden) zijn afgescheiden in `data/crops.js`. De bot kan hierdoor moeiteloos overweg met alle soorten gewassen: van normaal graan tot verticaal groeiende suikerriet en rechtsklik-gewassen zoals bessen.

**Hoe te gebruiken in-game**
* **Starten:** Typ `!farm` in de chat. De bot scant de omgeving, oogst alles wat rijp is, plant terug, voert de dieren en komt de opbrengst bij je brengen.
* **Stoppen:** Typ `!stopfarm` (of `!stop`) om de landbouwcyclus direct af te breken.

**Slimme Beveiligingen (Fail-safes)**
* **Gereedschap-veiligheid & Auto-Resupply (`equipSafeTool`):** Gewassen zoals meloenen en bamboe kosten duurzaamheid van je gereedschap. De bot houdt de *durability* in de gaten. Dreigt een tool te breken? Dan stopt hij met het gebruik ervan. Als `autoResupply` aanstaat, loopt de bot zelfs automatisch naar een werkbank om nieuw gereedschap te maken voordat hij verder boert.
* **Anti-Griefing bij Rechtsklikken (`equipNonPlaceable`):** Gewassen zoals bessen (Sweet Berries) moet je rechtsklikken. Als de bot toevallig een aarde-blok in zijn hand houdt, zou hij per ongeluk een blok plaatsen in plaats van oogsten. De bot zorgt er dus altijd voor dat hij iets veiligs vasthoudt (zoals een zwaard of leeg slot) bij interactie-gewassen.
* **Logische Volgorde (Fokken vóór Leveren):** De bot voert altijd eerst het `breedAnimals` script uit vóórdat hij zijn inventaris bij de speler komt dumpen. Doe je dit andersom, dan staat de bot met lege handen bij de koeien omdat hij al het graan net aan jou heeft gegeven.
* **Dynamische Leeftijdscheck (`maxAgeOf`):** De bot leest de maximale leeftijd van een gewas uit het Minecraft-register in plaats van uit hardgecodeerde getallen. Hierdoor snapt de bot feilloos dat kelp (25), bietjes (3) en graan (7) allemaal andere momenten van rijpheid hebben.
* **Anti-Vertrappen (`farmMovements`):** Parkour en sprint-springen worden uitgezet zodat de bot je *farmland* (geploegde aarde) niet per ongeluk kapot springt tijdens het oogsten.

**Stap-voor-stap Werking**
1. **Scannen (`scanCropBlocks`):** De bot zoekt in een straal om zich heen naar alle blokken die als 'oogstbaar' staan gemarkeerd in de crops-data.
2. **Taakbepaling (`buildTasks`):** Hij zet de blokken om in specifieke taken. Voor pompoenen controleert hij of er wel echt een stengel naast staat. Voor suikerriet pakt hij het tweede blok van onderen, en voor bessen gebruikt hij een rechtsklik.
3. **Oogsten & Opruimen:** Hij breekt de blokken, zuigt de gedropte items op en plant direct nieuw zaad terug als het gewas dat vereist (`CATEGORY.REPLANT`).
4. **Inventaris-Pauze:** Mocht de inventaris van de bot halverwege de oogst vol raken, pauzeert hij even, loopt hij naar de speler om de opbrengst (`toss`) af te geven, en gaat hij weer vrolijk verder waar hij gebleven was.
5. **Eindfase:** Als alle velden leeg zijn, gaat de bot met het verse voedsel de dieren fokken en brengt hij tot slot alle resterende surplus-opbrengst netjes bij je langs.

### 🎣 Vissen (`features/fishing.js`)

Deze module maakt van de bot een geduldige visser. Omdat de standaard vis-functie van Mineflayer erg simplistisch is en de bot makkelijk kan laten crashen, is deze module uitgerust met uitgebreide logica om een veilige oever te zoeken, worpen te timen en de vangst automatisch op te bergen.

**Hoe te gebruiken in-game**
* **Starten:** Typ `!vis` in de chat. De bot zoekt water, werpt zijn hengel uit en stopt pas als zijn inventaris vol is of de hengel bijna breekt.
* **Beperkt vissen:** Typ `!vis <aantal>` (bijv. `!vis 20`) om de bot na een specifiek aantal worpen te laten stoppen.
* **Stoppen:** Typ `!stopvis` (of `!stop`) om de vis-sessie direct te beëindigen.

**Slimme Beveiligingen (Fail-safes)**
* **Anti-Crash & Timeouts:** De standaard `bot.fish()` functie heeft geen timeout en crasht de bot als een worp wordt afgebroken. Deze module wikkelt de worp in een custom timeout en vangt zogenaamde *unhandled rejections* netjes op. Als de dobber op het gras belandt of een netwerkpakketje mist, loopt de bot dus niet meer vast.
* **Slimme Oever-detectie (`findFishingSpot`):** De bot vist niet *in* het water (waardoor hij zou wegdrijven door stroming), maar zoekt een solide blok op de oever met minimaal twee blokken lucht erboven (ruimte om te staan). Daarnaast berekent hij een mikpunt vérder het water op, zodat de dobber niet op de kant stuitert.
* **Auto-Eat Herstel:** Als de bot honger krijgt, wisselt de *auto-eat* functie de hengel om voor voedsel. Dit annuleert de worp. De vis-module herkent dit, pakt daarna opnieuw de hengel vast en werpt gewoon opnieuw in.
* **Hengel Behoud (`bestRod`):** Vóór elke worp wordt de durability gecheckt. De bot stopt met vissen zodra de hengel bijna kapot is (`minRodDurability`), zodat je betoverde hengels nooit per ongeluk breken.
* **Automatische Proviand:** Bij het afleveren in de kist dumpt de bot niet klakkeloos alles. Eetbare vissen worden tot een bepaalde drempel (`keepFood`) in de inventaris gehouden als proviand voor de bot zelf.

**Stap-voor-stap Werking**
1. **Voorbereiding & Navigatie:** De bot zoekt de beste hengel in zijn inventaris. Vervolgens zoekt hij open water, berekent hij de beste sta-plek en loopt hij ernaartoe.
2. **Werpen & Wachten:** De bot staat stil (lopen annuleert vissen), kijkt naar het water en werpt uit. Hij wacht tot de server het signaal stuurt dat er beet is.
3. **Vangst Registratie (`snapshot` & `diff`):** Vlak voor de worp en vlak na de worp maakt de bot een 'foto' van zijn inventaris. Door deze te vergelijken, weet de bot exact wat hij net gevangen heeft (inclusief betoverde boeken of rommel).
4. **Afleveren (`deliverCatch`):** Zit de inventaris vol of is het aantal worpen bereikt? Dan loopt de bot naar de invoerkist van het sorteersysteem. Hij legt de vangst erin en kan (als dit is geconfigureerd) direct de sorteer-module (`!sort`) triggeren om de vis netjes over het pakhuis te verdelen.


### ⛏️ Mijnbouw & Tunnels (`features/mining.js`)

Deze module is het brein achter het gestructureerd uitgraven van tunnels en gangen. In plaats van de standaard pathfinder blind te laten graven (wat vaak resulteert in lelijke gaten overal), berekent deze module een wiskundig pad en graaft dit cel voor cel superstrak uit.

**Hoe te gebruiken in-game**
* **Tunnel via kompas:** Typ `!tunnel noord 20` (of zuid, oost, west) om een rechte gang van 20 blokken lang te graven.
* **Tunnel naar doel:** Typ `!tunnel naar <x> <y> <z>` of `!tunnel naar mij` om de bot een gang te laten graven richting een specifiek punt of speler.
* **Afmetingen aanpassen:** Voeg breedte en hoogte toe aan het einde van je commando, bijvoorbeeld: `!tunnel noord 20 3 3` voor een gang van 3 bij 3.
* **Stoppen:** Typ `!stopmine` (of `!stop`) om de graafwerkzaamheden onmiddellijk te staken.

**Slimme Beveiligingen (Fail-safes)**
* **Gecontroleerd Graven (Anti-Kaasgat):** De pathfinder mag van deze module absoluut niet zelf graven (`canDig: false`). De module graaft zélf het pad vrij en laat de bot uitsluitend door de zelfgemaakte gang lopen. Dit voorkomt dat de bot dwars door muren of over de tunnel heen graaft.
* **Van Boven naar Beneden (`crossSection`):** De bot graaft per cel altijd eerst het plafond en dan pas de vloer. Draai je dit om, dan zakt de bot in een gat terwijl er nog steen op hoofdhoogte staat, waarna zand of grind direct op zijn hoofd valt.
* **Zwaartekracht-correctie (`digFallingBlocks`):** Blokken zoals grind, zand en aambeelden vallen naar beneden als je de vloer weghaalt. De bot wacht kort, detecteert of er iets gevallen is, en ruimt dit direct op zodat de tunnel echt netjes leeg is.
* **Lava Ontwijking (`lavaNearby`):** Voordat een blok gebroken wordt, scant de bot de 6 direct omliggende blokken. Ligt er lava tegenaan? Dan wordt het blok overgeslagen (`Lava in de weg, ik graaf er omheen!`), zodat de tunnel niet plotseling volstroomt.
* **Auto-Opslag (`storeBlocksInChest`):** Raakt de inventaris vol? De bot zoekt een kist (of plaatst er desnoods zelf een uit zijn inventaris) en slaat alle onnodige blokken op voordat hij verder werkt.
* **Slim Hervatten (`resumeFrom`):** Als de bot doodgaat, vlucht of herstart, onthoudt hij exact bij welke cel hij was gebleven (`lastMineData`). Hierdoor hoeft hij niet minutenlang in het niets te hakken om een al uitgegraven tunnel opnieuw te verwerken.

**Stap-voor-stap Werking**
1. **Traject Berekenen (`corridorCells`):** Maakt een vloerplan aan naar het doelpunt. Er wordt altijd maar op één as tegelijk bewogen. Dit zorgt voor nette trappen en voorkomt diagonale sprongen waar de bot zelf niet doorheen past.
2. **Gereedschap Kiezen (`equipBestTool`):** Kiest dynamisch het perfecte gereedschap uit de `TOOL_PREFERENCES` (bijl voor hout, schep voor zand, houweel voor steen) om de duurzaamheid en snelheid te optimaliseren.
3. **Breken (`safeDig`):** Het blok wordt gebroken met een strakke timeout (15 seconden). Als de server lagt of het blok niet breekt, blijft de bot niet voor eeuwig hangen.
4. **Verlichting (`placeBlock`):** Op vaste intervallen (`torchPlaceInterval`) plaatst de bot automatisch fakkels. Hij probeert deze bij voorkeur op de vloer te plaatsen in plaats van aan de muren.


### 🗄️ Inventaris & Sorteersysteem (`features/sorting.js`)

Deze module transformeert de bot in een volautomatisch magazijnsysteem. De bot leegt een centrale invoerkist en verdeelt de inhoud over alle omliggende kisten. Dit gebeurt niet blind, maar slim: op basis van de categorieën die zijn vastgelegd in `data/categories.js`.

**Hoe te gebruiken in-game**
* **Automatisch Sorteren:** Typ `!sort` in de chat. De bot zoekt automatisch de dichtstbijzijnde koperen kist (of gewone kist) als invoerbak, haalt deze leeg en begint met sorteren.
* **Specifieke Kist Sorteren:** Typ `!sort <x> <y> <z>` om zelf de coördinaten van de invoerkist aan te wijzen.
* **Stoppen:** Typ `!stopsort` (of `!stop`) om de sorteeractie direct af te breken.

**Slimme Beveiligingen (Fail-safes)**
* **Twee-rondes Algoritme:** Dit is de kern van de module. Ronde 1 loopt langs alle kisten en legt alléén items weg die *exact* overeenkomen (steen bij steen). Pas in Ronde 2 wordt de rest op categorie verdeeld. Dit voorkomt dat een gouden zwaard in de eerste de beste kist met een stenen zwaard belandt, terwijl er verderop in het pakhuis een specifieke gouden-zwaarden-kist staat.
* **Bevroren Quotum (`protectionQuota`):** De bot beschermt zijn eigen uitrusting (het beste gereedschap, pantser en wat voedsel) door een quotum vast te stellen. Dit quotum wordt één keer aan het begin van de sessie berekend en 'bevroren'. Dit voorkomt dat de bot spullen uit de invoerkist opeens als zijn eigen eigendom gaat beschouwen en weigert weg te leggen.
* **Ender Chest Uitsluiting:** De bot mag in normale kisten, vaten en alle kleuren shulker boxes kijken, maar de Ender Chest is expliciet uitgesloten. Die inventaris is speler-gebonden en daar blijft de bot veilig vanaf.
* **Anti-Drop Beveiliging (`returnCursorItem`):** Als een kist onverwachts vol is tijdens het verplaatsen, kan een item aan de virtuele muiscursor van de bot blijven plakken. Zonder de opruim-functie zou dit item op de grond vallen zodra de kist sluit. De bot stopt het nu altijd veilig terug in zijn eigen tas.
* **Auto-Indexatie:** Tijdens het openen van kisten leert de bot direct uit zijn hoofd wat erin ligt (`lib/storage.js`). Dit voedt het geheugen van de Koerier-module (`!haal` / `!waar`).

**Stap-voor-stap Werking**
1. **Voorbereiding:** De bot bevriest zijn eigen beschermde items en bepaalt welke kist de invoerkist is.
2. **Ophalen (`emptyInputChest`):** Opent de invoerkist en haalt alle vracht eruit, totdat zijn eigen inventaris de `minFreeSlots` limiet bereikt.
3. **Ronde 1 (Exact):** Loopt langs alle omliggende kisten. Hij scant de inhoud, leert deze uit zijn hoofd en stopt direct alle exacte matches weg.
4. **Ronde 2 (Categorie):** Kijkt wat hij na ronde 1 nog over heeft. Hij zoekt kisten die items van dezelfde categorie bevatten (zoals 'gereedschap' of 'landbouw') en deelt de rest daar in.
5. **Afronding:** De bot sluit alle vensters veilig af en rapporteert in de chat hoeveel items er exact en op categorie zijn weggewerkt, plus wat hij eventueel wegens ruimtegebrek bij zich heeft gehouden.

### 🛠️ Smid & Crafting (`features/toolsmith.js`)

Deze module maakt de bot volledig zelfvoorzienend. In plaats van domweg te stoppen als zijn houweel of schoffel breekt, zoekt de bot automatisch een werkbank of aambeeld op om zijn uitrusting te repareren of nieuw gereedschap te craften. 

**Hoe te gebruiken in-game**
* **Automatisch Aanvullen:** Typ `!gereedschap` in de chat. De bot controleert zijn inventaris en repareert of craft automatisch de basis-tools die hij mist.
* **Specifiek Craften:** Typ `!maak <item>` of `!maak <aantal> <item>` (bijvoorbeeld `!maak diamond_pickaxe` of `!maak 8 torch`) om de bot een specifieke opdracht te geven.
* **Stoppen:** Typ `!stopmaak` (of `!stop`) om de smid-sessie direct af te breken.
* **Op de achtergrond:** De *Farming* en *Mining* modules activeren dit script automatisch (in de stille modus) zodra ze merken dat hun gereedschap op het punt staat te breken.

**Slimme Beveiligingen (Fail-safes)**
* **Repareren gaat voor Maken:** Voordat de bot grondstoffen verspilt, zoekt hij een aambeeld om twee versleten tools samen te voegen. Hij pakt hierbij slim de twee meest versleten exemplaren. Dit behoudt de "tier" (bijv. diamant) en eventuele betoveringen, wat veel waardevoller is dan een nieuw stenen exemplaar maken.
* **Duurzaamheid boven Tier:** Bij het craften van nieuw gereedschap kijkt de bot naar de daadwerkelijke levensduur (`maxDurability`). Hij is geprogrammeerd om te weten dat een stenen houweel (131 slagen) beter is dan een gouden houweel (32 slagen), zodat hij geen dure maar zwakke materialen verspilt.
* **Dynamische Recursie & Anti-Loop:** De bot gebruikt geen hardgecodeerde recepten. Hij vraagt aan de server (`recipe.delta`) wat er exact nodig is. Ontbreken er stokken? Dan maakt hij die eerst zelf van planken (en de planken van hout). Om te voorkomen dat dit in een oneindige cirkel vastloopt, zit er een strikte diepte-limiet (`maxDepth`) en een `bezig` beveiliging op.
* **Voorraad-Integratie:** Voor hij begint te craften, communiceert deze module met het geheugen van de Sorteer- en Koerier-module. Hij haalt ontbrekende grondstoffen dus eerst efficiënt uit nabijgelegen kisten.
* **Anti-Crash Timeouts:** Standaard Mineflayer functies zoals `bot.craft()` en `anvil.combine()` wachten op server-pakketjes (zoals een *experience event*) die op sommige servers nooit aankomen. Deze functies zijn strak in een timeout gewikkeld, zodat de bot nooit permanent bevriest bij een werkbank.

**Stap-voor-stap Werking**
1. **Inventarisatie:** De bot controleert of er onmisbaar gereedschap (zoals zwaarden, houwelen of schoffels) onder de veilige duurzaamheidsdrempel is beland.
2. **Reparatieronde:** Is reparatie ingeschakeld? Dan navigeert de bot eerst naar een aambeeld en combineert hij de gebrekkige tools om ze te herstellen.
3. **Crafting Voorbereiden:** Als er nog steeds gereedschap ontbreekt, loopt de bot naar een werkbank (`goToBlock`) – hij plaatst deze bewust niet zelf om de wereld netjes te houden. Er wordt iets onschuldigs vastgehouden (`equipNonPlaceable`) zodat hij bij het rechtsklikken op de werkbank niet per ongeluk een blok plaatst.
4. **Materialen Verzamelen:** Ontbrekende grondstoffen worden uit kisten gehaald of ter plekke in tussenstappen gecraft.
5. **Smeden & Afronden:** De bot craft het benodigde item, sluit de GUI-vensters netjes af en rapporteert in de chat wat er precies is gerepareerd of geproduceerd.

### 🤝 Handel & Economie (`features/trading.js`)

Deze module transformeert de bot in een volautomatische handelaar. Hij haalt landbouwgewassen uit de opslag, bezoekt een handelshal met dorpelingen (villagers), verkoopt alles voor smaragden (emeralds) en bergt de pure winst netjes op in een kluiskist.

**Hoe te gebruiken in-game**
* **Automatisch:** Typ `!trade` in de chat. De bot zoekt zelf de dichtstbijzijnde kist met gewassen en handelt met dorpelingen in de directe omgeving.
* **Geavanceerd (Op afstand):** Typ `!trade kist <x> <y> <z> hal <x> <y> <z> [kluis <x> <y> <z>]` om de bot een exacte route te geven. Handig als je boerderij, handelshal en kluis ver uit elkaar liggen.
* **Stoppen:** Typ `!stoptrade` (of `!stop`) om het handelen direct te beëindigen.

**Slimme Beveiligingen (Fail-safes)**
* **Native GUI-afhandeling:** De bot klikt niet handmatig in inventaris-schermpjes (wat gegarandeerd tot desync-crashes leidt bij lag), maar gebruikt de ingebouwde `bot.trade()` protocollen. Dit handelt wisselgeld, packet-verkeer en slot-verplaatsingen feilloos af.
* **Dynamische Prijsberekening (`realPrice`):** De bot rekent niet met de basisprijs van een item, maar met de *echte* prijs. Hierdoor snapt de bot het perfect als prijzen stijgen door veelvuldig handelen, of dalen dankzij reputatie of *Hero of the Village*.
* **Strikte Entiteit-Filter:** De bot filtert hard op de naam `villager`. *Wandering traders*, *zombie villagers* of *illagers* worden genegeerd. Zonder deze check zou de onderliggende code hard crashen.
* **Beroeps- en Ruilfilter (`isCropSale`):** De bot checkt scherp of de aanbieding wel "gewas voor smaragd" is. Dit voorkomt dat hij per ongeluk smaragden uitgeeft om brood te kópen, of bij een visser of bibliothecaris probeert te pinnen.
* **Anti-Vastloop (Ruimte-check):** Voordat de bot op de ruil-knop drukt, controleert hij of hij wel een vrije plek of een bestaande stack smaragden in zijn inventaris heeft. Zonder plek kan de ruil niet voltooien en zou het scherm voor eeuwig open blijven staan.
* **Gegarandeerde Venster-Cleanup:** Dankzij het `finally`-blok wordt het handelsscherm áltijd gesloten. Zelfs als een dorpeling halverwege in een mijnkarretje stapt of wegrent, bevriest de bot niet.

**Stap-voor-stap Werking**
1. **Inladen (`withdrawCrops`):** De bot opent de voorraadkist en pakt zoveel mogelijk verhandelbare gewassen (zoals wortels, aardappelen, tarwe). Hij filtert bewust zaken als glow berries eruit, omdat boeren die niet accepteren.
2. **Navigatie:** Hij loopt (veilig zonder blokken te breken of plaatsen) naar de ingestelde handelshal of zoekt dorpelingen in de buurt.
3. **Onderhandelen (`tradeWithVillager`):** Hij stapt op elke dorpeling af, controleert of ze boer zijn, en pompt de ruilen maximaal vol totdat de dorpeling weigert (trade locked) of de gewassen op zijn.
4. **Winst Afstorten (`depositEmeralds`):** Na zijn ronde navigeert de bot naar de kluiskist (of terug naar de invoerkist) en stort hij alle verdiende smaragden veilig af.

## Datastructuren

De `data/` directory bevat statische informatie en parameters die door de features worden geraadpleegd:

### 🗂️ Categorieënwoordenboek (`data/categories.js`)

Dit bestand fungeert als de encyclopedie van de bot. Het vertaalt specifieke itemnamen (zoals `diamond_sword` of `stone_sword`) naar logische, overkoepelende groepen (zoals `zwaarden`). Het sorteersysteem gebruikt dit om te bepalen in welke kist een item thuishoort. 

**Hoe te gebruiken in-game**
* Dit is een configuratiebestand en vereist geen directe commando's. De regels worden op de achtergrond automatisch toegepast zodra je het commando `!sort` gebruikt.
* Als je nieuwe items uit een mod of toekomstige Minecraft-update wilt groeperen, voeg je simpelweg hier een nieuwe regel toe met een *Regular Expression* (Regex).

**Slimme Beveiligingen (Fail-safes)**
* **Strikte Hiërarchie (Top-down):** De regels worden strikt van boven naar beneden afgehandeld en de eerste treffer wint. Dit voorkomt overlappende fouten: een `pickaxe` eindigt bijvoorbeeld op de letters `axe`. Doordat de pikhouweel-regel bóven de bijl-regel staat, belanden ze nooit in de verkeerde kist.
* **Geen 'Overig'-categorie:** Items die door geen enkele regel worden herkend, krijgen bewust de waarde `null` in plaats van een mapje "overig". Hierdoor zal de sorteermodule deze items uitsluitend bij exact dezelfde items leggen, wat voorkomt dat één kist een onoverzichtelijke verzamelbak van willekeurige blokken wordt.
* **Dynamische Voedselherkenning:** Voedsel wordt niet via een hardgecodeerde lijst herkend, maar direct aan de interne Minecraft-engine (`registry.foodsByName`) gevraagd. Dit betekent dat nieuw voedsel in latere updates direct wordt herkend zonder de code aan te passen.
* **Giftige Uitzonderingen:** Rot vlees (`rotten_flesh`) en spinnenogen (`spider_eye`) worden door Minecraft gezien als eetbaar, maar staan in deze code hard ingecodeerd bóven de voedsel-regel. Hierdoor verhuizen ze netjes naar de `mobdrops`-kisten en belanden ze niet in je keukenkist.

**Stap-voor-stap Werking**
1. **Invoer:** De sorteermodule roept `categoryOf(registry, itemName)` aan voor een item in de inventaris.
2. **Evaluatie:** De bot loopt de lijst met regels af. Hij test de itemnaam tegen de Regex-patronen (bijv. eindigt het op `_bed` of begint het met `raw_`).
3. **Match:** Zodra een patroon of functie (zoals de voedselcheck) `true` teruggeeft, stopt het zoeken direct en retourneert het script de categorienaam.
4. **Fallback:** Is de hele lijst doorlopen zonder resultaat? Dan geeft het script `null` terug, waarna de sorteermodule terugvalt op exact-matchen.

### 🌱 Gewasregister & Landbouwlogica (`data/crops.js`)

Dit bestand vormt het agrarische brein van de bot. In plaats van in het landbouw-script eindeloze `if/else`-lijsten te maken, definieert dit register per gewas exact *hoe* het groeit, *wanneer* het rijp is, en *op welke manier* het geoogst moet worden.

**Hoe te gebruiken in-game**
* Dit bestand draait volledig op de achtergrond zodra je `!farm` gebruikt.
* Wil je een nieuw gewas uit een toekomstige Minecraft-update (of mods) toevoegen? Dan hoef je het alleen hier in de `CROP_LIST` te registreren met de juiste categorie en eigenschappen. De `farming.js` module snapt de rest dan vanzelf.

**De Vier Oogstcategorieën**
* **`REPLANT` (Bv. Tarwe, Wortels, Cacao):** Breek het volgroeide blok en plant het gedefinieerde zaad direct terug. Bepaalt zelfs óf het op de grond moet (`below`) of tegen de zijkant van een boom (`side`).
* **`FRUIT` (Bv. Meloen, Pompoen):** Breek uitsluitend de vrucht. De stengel waaraan de vrucht groeide, wordt met rust gelaten.
* **`INTERACT` (Bv. Zoete Bessen):** Oogst het gewas met een rechtsklik. Het blok zelf wordt nooit fysiek gebroken.
* **`VERTICAL` (Bv. Suikerriet, Bamboes):** Breek het *tweede* blok van onderen. De voet van de plant blijft hierdoor intact zodat deze direct weer kan aangroeien.

**Slimme Beveiligingen (Fail-safes)**
* **De Absolute Zwarte Lijst (`NEVER_BREAK`):** Zelfs als er elders in de logica een berekeningsfout optreedt, weigert de bot categorisch om blokken uit deze lijst te breken. Stengels, onvolgroeide gewassen (zoals de `torchflower_crop`) en akkerland (`farmland`) zijn hierdoor 100% veilig.
* **Geavanceerde Rijpheidscheck (`ripeAtMaxAge`):** Block-states komen vanuit de server vaak als *string* (bijv. `"7"`) binnen. Deze module lost die verwarring veilig op. Voor complexe twee-hoge planten (zoals de *Pitcher Plant*) is de bot geprogrammeerd om heel specifiek naar de onderste helft te kijken.
* **Voorraadbeheer (`YIELD_ITEMS` & `SEED_ITEMS`):** Door expliciet te definiëren wat telt als oogst (Yield) en wat telt als zaaigoed (Seed), voorkomt de bot dat hij onbedoeld items dropt of weigert te herplanten.
  
### 🎵 Liedjesboek & Entertainment (`data/songs.js`)

Dit bestand is de muzikale bibliotheek van de bot. Het is een pure data-module die uitsluitend songteksten bevat en deze via een kleine 'wrapper' (omhullende code) beschikbaar stelt aan de andere systemen. Door deze grote blokken tekst af te scheiden van de actieve logica, blijft de hoofdcode van de bot schoon en overzichtelijk.

**Hoe te gebruiken in-game**
* **Zingen:** Typ `zing`, `zingen` of `muziek` in de algemene chat. De Chat-module raadpleegt vervolgens dit bestand en begint de zinnen stuk voor stuk in de chat te typen.
* **Liedjes toevoegen:** Je kunt de bot eenvoudig nieuwe liedjes leren door in dit bestand een nieuw `songBook.add('Titel', ['Regel 1', 'Regel 2'])` blok toe te voegen.

**Slimme Architectuur & Beveiligingen**
* **Object-Georiënteerd (OOP):** In plaats van een simpele, losse lijst met tekst te gebruiken, maakt dit script gebruik van strakke `Song` en `SongBook` classes. Dit maakt het ophalen van data voorspelbaar en gestructureerd.
* **Safe Randomizer (`getRandom`):** De bot kiest volautomatisch een willekeurig liedje uit de lijst. Mocht je per ongeluk alle liedjes uit de code verwijderen, dan crasht de bot niet dankzij een ingebouwde check die simpelweg `null` teruggeeft als de bibliotheek leeg is.

**Stap-voor-stap Werking**
1. **Verzoek:** De `chat.js` module hoort het woord "zing" in de chat en vraagt aan dit bestand om een liedje.
2. **Selectie:** De `SongBook` class pakt via wiskundige willekeur (`Math.random()`) een van de beschikbare nummers (zoals "I Got Bills" of "Stay").
3. **Uitlevering:** Het geselecteerde liedje wordt teruggestuurd naar de chat-module, die vervolgens met een subtiele vertraging (`SONG_LINE_DELAY`) de array met regels tekst in de Minecraft-wereld typt alsof hij echt aan het meezingen is.

## Onderliggende Architectuur & Libraries

Het project is robuust opgezet met externe afhankelijkheden en interne helper-scripts:

*   **Configuratie**: De algemene instellingen, servergegevens en bot-parameters worden beheerd vanuit `config.js`.
*   **Lib Directory**: Bevat gedeelde technische logica. `containers.js`
*   **Node Modules**: De bot leunt zwaar op externe npm-pakketten. Opvallende afhankelijkheden zijn onder andere `@nxg-org/mineflayer-util-plugin` voor uitgebreide Mineflayer utilities, `protodef-validator` voor protocol data, en `@azure/msal-node` voor de authenticatie via Microsoft-accounts, wat tegenwoordig vereist is voor Minecraft.

## Installatie

Om de bot te laten draaien, dienen de Node.js afhankelijkheden geïnstalleerd te worden. Start hiervoor het volgende commando in de hoofdmap:

```bash
npm install

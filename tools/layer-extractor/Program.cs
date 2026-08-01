using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Serilog;

// Extracts a SquadLayerList-schema layers.json (see data/sources/*/layers.json) straight from cooked game files:
// the local Squad install plus a workshop mod directory. This is a port of SquadLayerList's exporter.py, which can
// only run inside the Squad SDK's editor; here the same assets are read from the shipped IoStore containers via
// CUE4Parse. Squad's containers are unencrypted and cook with versioned properties, so no AES key or usmap needed.
//
// usage: LayerExtractor <modDir> [--game <squadInstall>] [--out <file>]
//        LayerExtractor --vanilla [--game <squadInstall>] [--out <file>]
//        LayerExtractor --plan <modDir> [--game <squadInstall>]
//   <modDir>   a workshop item directory (steamapps/workshop/content/393380/<id>) or any directory of mod paks
//   --vanilla  export the base game's layers. Omit <modDir>: a mounted mod can shadow base game assets
//   --plan     list which of the mod's .ucas containers hold layer data. Works from the .utoc indexes alone
//              (fetch-workshop-mod.sh downloads those first, then only the containers this prints)

var argv = new List<string>(args);
string? TakeOpt(string name)
{
	var i = argv.IndexOf(name);
	if (i < 0 || i + 1 >= argv.Count) return null;
	var v = argv[i + 1];
	argv.RemoveRange(i, 2);
	return v;
}
var gameDir = TakeOpt("--game")
	?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local/share/Steam/steamapps/common/Squad");
var outPath = TakeOpt("--out");
var vanilla = argv.Remove("--vanilla");
var plan = argv.Remove("--plan");
var command = argv.FirstOrDefault(a => a.StartsWith("list:") || a.StartsWith("dump:"));
var modDir = argv.FirstOrDefault(a => a != command);
if (modDir == null && (plan || !vanilla))
{
	throw new Exception("usage: LayerExtractor <modDir> [--game <squadInstall>] [--out <file>] [--vanilla] [--plan]");
}
var gamePaks = Path.Combine(gameDir, "SquadGame/Content/Paks");
if (!Directory.Exists(gamePaks))
{
	throw new Exception($"no Squad install at {gameDir} (missing SquadGame/Content/Paks); pass --game <squadInstall>");
}

Log.Logger = new LoggerConfiguration().WriteTo.Console(standardErrorFromLevel: Serilog.Events.LogEventLevel.Verbose).MinimumLevel.Error().CreateLogger();

// the package paths extraction reads out of a mod; --plan reports the containers that hold them, and a partial
// fetch that has only those containers still extracts completely
// GLD is Galactic Contention's spelling of Gameplay_Layer_Data
var neededPathMarkers = new[] { "/Gameplay_Layer_Data/", "/GLD/", "/Settings/FactionSetups/", "/Settings/Factions/", "/Settings/Availability/" };

// the gamemodes with a defending side; mirrors ASYMM_GAMEMODES in src/models/layer.ts
var asymmetricGamemodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Invasion", "Insurgency", "Destruction" };

if (plan)
{
	// a .utoc holds the container's entire directory index; the .ucas holds only bulk data. Stubbing empty .ucas
	// files lets the provider mount and list index-only fetches.
	foreach (var utoc in Directory.EnumerateFiles(modDir!, "*.utoc", SearchOption.AllDirectories))
	{
		var ucas = Path.ChangeExtension(utoc, ".ucas");
		if (!File.Exists(ucas)) File.Create(ucas).Dispose();
	}
}

var provider = new DefaultFileProvider(
	new DirectoryInfo(gamePaks),
	modDir != null ? new[] { new DirectoryInfo(modDir) } : Array.Empty<DirectoryInfo>(),
	SearchOption.AllDirectories,
	true,
	// Squad cooks UE5.4, unencrypted, with versioned properties. An engine upgrade needs this bumped; a switch to
	// unversioned cooks would also need a .usmap
	new VersionContainer(EGame.GAME_UE5_4));
provider.Initialize();
provider.Mount();
Console.Error.WriteLine($"mounted {provider.MountedVfs.Count} containers, {provider.Files.Count} files");

if (plan)
{
	var gamePakDir = Path.GetFullPath(gamePaks);
	foreach (var vfs in provider.MountedVfs.OrderBy(v => v.Name, StringComparer.Ordinal))
	{
		if (Path.GetFullPath(vfs.Path).StartsWith(gamePakDir)) continue;
		if (!vfs.Files.Keys.Any(f => neededPathMarkers.Any(f.Contains))) continue;
		Console.WriteLine(Path.ChangeExtension(Path.GetFileName(vfs.Path), ".ucas"));
	}
	return;
}

bool IsModPath(string key) => key.StartsWith("SquadGame/Plugins/Mods/", StringComparison.OrdinalIgnoreCase);

// every by-name asset lookup scans this instead of provider.Files.Keys: vanilla must not resolve into the mounted
// mod's files, a mod's own asset must beat a same-named base game one, and ordinal order keeps the pick stable
// across machines where raw enumeration order is not. Keys repeat across a mod's per-platform cooks of the same
// packages, hence the Distinct.
var searchKeys = provider.Files.Keys
	.Where(k => !(vanilla && IsModPath(k)))
	.Distinct()
	.OrderByDescending(IsModPath)
	.ThenBy(k => k, StringComparer.Ordinal)
	.ToList();

// list:<substring> prints matching mounted file paths instead of extracting; for poking at a mod's layout
if (command != null && command.StartsWith("list:"))
{
	var needle = command["list:".Length..];
	var matches = provider.Files.Keys
		.Where(k => k.Contains(needle, StringComparison.OrdinalIgnoreCase))
		.Distinct()
		.OrderBy(k => k, StringComparer.Ordinal)
		.ToList();
	foreach (var k in matches.Take(200)) Console.WriteLine(k);
	if (matches.Count > 200) Console.WriteLine($"... {matches.Count - 200} more; narrow the substring");
	return;
}

// ---------------------------------------------------------------- helpers

// "/Game/X" content paths map onto the base game; "/<Plugin>/X" onto whichever plugin root has the package
IEnumerable<string> CandidateFilePaths(string packagePath)
{
	if (!packagePath.StartsWith('/'))
	{
		yield return packagePath;
		yield break;
	}
	var slash = packagePath.IndexOf('/', 1);
	if (slash < 0) yield break;
	var root = packagePath[1..slash];
	var rest = packagePath[(slash + 1)..];
	if (root == "Game")
	{
		yield return $"SquadGame/Content/{rest}.uasset";
		yield break;
	}
	yield return $"SquadGame/Plugins/Mods/{root}/Content/{rest}.uasset";
	yield return $"SquadGame/Plugins/Expansions/{root}/Content/{rest}.uasset";
	yield return $"SquadGame/Plugins/{root}/Content/{rest}.uasset";
}

var exportsCache = new Dictionary<string, JArray?>();
JArray? LoadExports(string path)
{
	if (exportsCache.TryGetValue(path, out var cached)) return cached;
	JArray? result = null;
	var candidates = CandidateFilePaths(path).Where(provider.Files.ContainsKey).ToList();
	if (candidates.Count == 0)
	{
		Console.Error.WriteLine($"warn: no game file for {path}");
	}
	else
	{
		try
		{
			var pkg = provider.LoadPackage(candidates[0]);
			result = JArray.FromObject(pkg.GetExports(), JsonSerializer.CreateDefault());
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"warn: failed to load {path}: {e.Message}");
		}
	}
	exportsCache[path] = result;
	return result;
}

// object paths look like "/Game/Settings/X.X" or "/Game/Settings/X.0"; the package is the part before the last dot
string? PackageOfObjectPath(string? objectPath)
{
	if (string.IsNullOrEmpty(objectPath)) return null;
	var dot = objectPath.LastIndexOf('.');
	return dot > 0 ? objectPath[..dot] : objectPath;
}

string? RefPackage(JToken? reference) =>
	PackageOfObjectPath(reference?["AssetPathName"]?.ToString() ?? reference?["ObjectPath"]?.ToString());

string BaseName(string path) => path[(path.LastIndexOf('/') + 1)..];

// "Class'Package:Export'" -> "Package:Export"; null when the shape is anything else, rather than crashing on it
string? QuotedName(JToken? objectName)
{
	var parts = objectName?.ToString().Split('\'');
	return parts?.Length >= 3 ? parts[^2] : null;
}

// dump:<substring> prints the raw exports of the first mounted package matching the substring; for working out
// which property holds a value
if (command != null && command.StartsWith("dump:"))
{
	var needle = command["dump:".Length..];
	var file = searchKeys
		.Where(k => k.EndsWith(".uasset") && k.Contains(needle, StringComparison.OrdinalIgnoreCase))
		.OrderBy(k => k.Length)
		.FirstOrDefault();
	if (file == null)
	{
		Console.Error.WriteLine($"no package matching {needle}");
		return;
	}
	Console.Error.WriteLine($"dumping {file}");
	var dumped = LoadExports(file)?.ToString(Formatting.Indented) ?? "null";
	if (outPath != null) File.WriteAllText(outPath, dumped);
	else Console.WriteLine(dumped);
	return;
}

// FText serializes as one of several shapes depending on how it was authored
string TextToString(JToken? text)
{
	if (text == null || text.Type != JTokenType.Object) return text?.ToString() ?? "";
	return text["LocalizedString"]?.ToString()
		?? text["SourceString"]?.ToString()
		?? (text["CultureInvariantString"]?.Type == JTokenType.String ? text["CultureInvariantString"]!.ToString() : "");
}

// blueprint enums serialize as "SQEAlliance::NewEnumerator21"; their display names live in the enum asset
var enumDisplayNames = new Dictionary<string, string>();
void LoadEnumDisplayNames(string enumName)
{
	var file = searchKeys.FirstOrDefault(k => k.EndsWith($"/{enumName}.uasset", StringComparison.OrdinalIgnoreCase));
	if (file == null) return;
	var exports = LoadExports(file);
	var map = exports?.FirstOrDefault(e => e["Type"]?.ToString() == "UserDefinedEnum")?["Properties"]?["DisplayNameMap"];
	if (map == null) return;
	foreach (var entry in map)
	{
		enumDisplayNames[$"{enumName}::{entry["Key"]}"] = TextToString(entry["Value"]);
	}
}
string EnumName(JToken? value)
{
	var raw = value?.ToString() ?? "";
	if (enumDisplayNames.TryGetValue(raw, out var display)) return display;
	return raw.Contains("::") ? raw.Split("::")[^1] : raw;
}

JToken? FindRowField(JToken row, string field)
{
	if (row is not JObject obj) return null;
	foreach (var prop in obj.Properties())
	{
		// user-defined struct fields carry a "_<index>_<guid>" suffix
		if (prop.Name == field || prop.Name.StartsWith(field + "_")) return prop.Value;
	}
	return null;
}

LoadEnumDisplayNames("SQEAlliance");
LoadEnumDisplayNames("ESQFactionSetupType");

// ---------------------------------------------------------------- faction alliances and names

// FactionTable rows give faction display names; Faction_<id> assets give the alliance
var factionNames = new Dictionary<string, string>();
foreach (var tableFile in searchKeys.Where(k => k.EndsWith("FactionTable.uasset")))
{
	var rows = LoadExports(tableFile)?.FirstOrDefault(e => e["Type"]?.ToString() == "DataTable")?["Rows"];
	if (rows is not JObject rowsObj) continue;
	foreach (var row in rowsObj.Properties())
	{
		var display = TextToString(FindRowField(row.Value, "DisplayName"));
		if (display != "") factionNames.TryAdd(row.Name, display);
	}
}

var factionAlliances = new Dictionary<string, string>();
string AllianceOf(string factionId)
{
	if (factionAlliances.TryGetValue(factionId, out var cached)) return cached;
	var file = searchKeys.FirstOrDefault(k => k.EndsWith($"/Faction_{factionId}.uasset", StringComparison.OrdinalIgnoreCase));
	var alliance = "INDEPENDENT";
	if (file != null)
	{
		var export = LoadExports(file)?.FirstOrDefault(e => e["Properties"]?["Alliance"] != null);
		if (export != null) alliance = EnumName(export["Properties"]!["Alliance"]);
	}
	else
	{
		Console.Error.WriteLine($"warn: no Faction_{factionId} asset; alliance defaults to INDEPENDENT");
	}
	factionAlliances[factionId] = alliance;
	return alliance;
}

// ---------------------------------------------------------------- layers

var layerFiles = searchKeys
	.Where(k =>
		(k.Contains("/Gameplay_Layer_Data/", StringComparison.OrdinalIgnoreCase) || k.Contains("/GLD/", StringComparison.OrdinalIgnoreCase))
		&& k.EndsWith(".uasset"))
	// the base game ships maps under three roots: SquadGame/Content, Plugins/Expansions/<Map> and a bare
	// Plugins/<Map> (Al Basrah). Only Plugins/Mods is a mod, so vanilla is everything else (searchKeys has
	// already dropped the mod's files when vanilla).
	.Where(k => vanilla || IsModPath(k))
	.Where(k => !BaseName(k).Contains("LayerTable"))
	.OrderBy(k => k, StringComparer.Ordinal)
	.ToList();
Console.Error.WriteLine($"found {layerFiles.Count} layer packages");

// every faction setup referenced by any layer ends up in Units
var referencedSetups = new Dictionary<string, string>(); // package path -> row name (filled while walking layers)
var maps = new JArray();

foreach (var layerFile in layerFiles)
{
	var exports = LoadExports(layerFile);
	var layer = exports?.FirstOrDefault(e => e["Properties"]?["TeamConfigs"] != null);
	if (layer == null) continue;
	var props = (JObject)layer["Properties"]!;
	// the base game's layers are named by their DataTable row, which matches the package everywhere except Jensens
	// Range, whose packages carry a Training_ infix the layer name does not. Mods are named by their package
	// instead: their row names are copied along with the asset and left stale (Resurgence files
	// RS_Yehorivka_Invasion_v2 under the row RS_Yehorivka_Domination_v1, and both rows exist).
	var rowName = vanilla ? props["Data"]?["RowName"]?.ToString() : null;
	var levelName = !string.IsNullOrEmpty(rowName)
		? rowName
		: BaseName(PackageOfObjectPath(layer["Package"]?.ToString()) ?? layerFile.Replace(".uasset", ""));

	string SetupRowName(string setupPackage)
	{
		if (referencedSetups.TryGetValue(setupPackage, out var known)) return known;
		var setup = LoadExports(setupPackage)?.FirstOrDefault(e => e["Properties"]?["FactionId"] != null);
		var rowName = setup?["Properties"]?["Data"]?["RowName"]?.ToString() ?? BaseName(setupPackage);
		referencedSetups[setupPackage] = rowName;
		return rowName;
	}

	var teamConfigs = new JObject();
	foreach (var configRef in (props["TeamConfigs"] as JArray) ?? new JArray())
	{
		var exportName = QuotedName(configRef["ObjectName"])?.Split(':')[^1];
		var config = exports!.FirstOrDefault(e => e["Name"]?.ToString() == exportName)?["Properties"] as JObject;
		if (config == null) continue;
		// the config's Index names its slot; cooked data omits it for the default, Team_One. Position in the
		// TeamConfigs array is not authoritative, and neutral (civilian) configs are not a playable slot.
		var slot = config["Index"]?.ToString() ?? "ESQTeam::Team_One";
		var teamNumber = slot.EndsWith("Team_One") ? 1 : slot.EndsWith("Team_Two") ? 2 : 0;
		if (teamNumber == 0) continue;
		var setupPackage = RefPackage(config["SpecificFactionSetup"]);
		// the blueprint decides attack/defend at runtime; in the data it shows as which role of default setup the
		// team was given (LargeMap-Offense vs LargeMap-Defense). A team is one or the other, so anything not
		// defending attacks: the symmetric modes take their setups from SmallMap, which carries neither marker.
		var defending = setupPackage?.Contains("-Defense", StringComparison.OrdinalIgnoreCase) ?? false;
		var team = new JObject
		{
			["index"] = teamNumber,
			["playerPercent"] = config["PlayerPercentage"]?.ToObject<double>() ?? 50,
			["tickets"] = config["Tickets"]?.ToObject<double>() ?? 0,
			["disabledVeh"] = config["DisableVehicleDuringStaggingPhase"]?.ToObject<bool>() ?? false,
			["isAttackingTeam"] = !defending,
			["isDefendingTeam"] = defending,
			["allowedAlliances"] = new JArray(((config["Allowed Alliances"] as JArray) ?? new JArray()).Select(EnumName)),
		};
		if (setupPackage != null) team["defaultFactionUnit"] = SetupRowName(setupPackage);
		teamConfigs[$"team{teamNumber}"] = team;
	}

	// an asymmetric layer always has a defender, but only says so in the setup paths when the two sides draw on
	// different tiers. Where both draw on the same one there is no marker to read, and team two defends.
	if (asymmetricGamemodes.Contains(props["GameMode"]?["RowName"]?.ToString() ?? "")
		&& teamConfigs["team1"] is JObject firstTeam && teamConfigs["team2"] is JObject secondTeam
		&& !firstTeam["isDefendingTeam"]!.ToObject<bool>() && !secondTeam["isDefendingTeam"]!.ToObject<bool>())
	{
		secondTeam["isAttackingTeam"] = false;
		secondTeam["isDefendingTeam"] = true;
	}

	var separated = props["bSeparatedFactionsList"]?.ToObject<bool>()
		?? (props["FactionsListTeamTwo"] is JArray { Count: > 0 });
	var factions = new JArray();
	foreach (var (list, teamIndex) in new[] { (props["FactionsList"], 1), (props["FactionsListTeamTwo"], 2) })
	{
		if (list is not JArray entries) continue;
		foreach (var entry in entries)
		{
			var factionId = entry["Key"]?.ToString();
			if (string.IsNullOrEmpty(factionId)) continue;
			var defaultSetupPackage = RefPackage(entry["Value"]?["Faction"]);
			var types = new JArray(((entry["Value"]?["Types"] as JArray) ?? new JArray()).Select(t => t["Key"]?.ToString()).OfType<string>());
			factions.Add(new JObject
			{
				["factionId"] = factionId,
				["defaultUnit"] = defaultSetupPackage != null ? SetupRowName(defaultSetupPackage) : null,
				["availableOnTeams"] = separated ? new JArray(teamIndex) : new JArray(1, 2),
				["types"] = types,
			});
			foreach (var type in (entry["Value"]?["Types"] as JArray) ?? new JArray())
			{
				var typeSetup = RefPackage(type["Value"]);
				if (typeSetup != null) SetupRowName(typeSetup);
			}
		}
	}

	var gameFlags = props["GameFlags"] as JObject;
	maps.Add(new JObject
	{
		["Name"] = levelName.Replace('_', ' '),
		["rawName"] = levelName,
		["levelName"] = levelName,
		["gamemode"] = props["GameMode"]?["RowName"]?.ToString() ?? "",
		["mapId"] = props["LevelId"]?.ToString() ?? "",
		["mapName"] = props["LevelId"]?.ToString() ?? "",
		["biome"] = "",
		["mapSize"] = "",
		["lightingLevel"] = "",
		["commander"] = !(gameFlags?["CommanderDisabled"]?.ToObject<bool>() ?? gameFlags?["bCommanderDisabled"]?.ToObject<bool>() ?? false),
		["persistentLightingType"] = props["PersistentLightingType"]?["RowName"]?.ToString(),
		["factions"] = factions,
		["separatedFactionsList"] = separated,
		["teamConfigs"] = teamConfigs,
	});
}

// ---------------------------------------------------------------- units

double RestrictionValue(JToken? reference, params string[] fields)
{
	var package = RefPackage(reference);
	if (package == null) return 0;
	var export = LoadExports(package)?.FirstOrDefault(e => e["Properties"] != null);
	foreach (var field in fields)
	{
		var value = export?["Properties"]?[field];
		if (value == null || value.Type == JTokenType.Null) continue;
		if (value.Type is JTokenType.Integer or JTokenType.Float) return value.ToObject<double>();
		// FTimespan; the layer lists speak minutes
		if (value["Ticks"] != null) return value["Ticks"]!.ToObject<double>() / 1e7 / 60;
	}
	return 0;
}

var units = new JObject();
foreach (var (setupPackage, rowName) in referencedSetups.OrderBy(kv => kv.Value, StringComparer.Ordinal))
{
	if (units.ContainsKey(rowName)) continue;
	var exports = LoadExports(setupPackage);
	var setup = exports?.FirstOrDefault(e => e["Properties"]?["FactionId"] != null);
	if (setup == null)
	{
		Console.Error.WriteLine($"warn: no faction setup export in {setupPackage}");
		continue;
	}
	var props = (JObject)setup["Properties"]!;
	var factionId = props["FactionId"]!.ToString();

	// the setup's own DataTable row carries the unit display name
	var displayName = rowName;
	var tablePackage = RefPackage(props["Data"]?["DataTable"]);
	if (tablePackage != null)
	{
		var rows = LoadExports(tablePackage)?.FirstOrDefault(e => e["Type"]?.ToString() == "DataTable")?["Rows"];
		var row = rows?[rowName];
		if (row != null)
		{
			var text = TextToString(FindRowField(row, "DisplayName"));
			if (text != "") displayName = text;
		}
	}

	// each characteristic is a row reference into FactionCharacteristicTable, whose row holds the display text
	var characteristics = new JArray();
	foreach (var reference in (props["Characteristics"] as JArray) ?? new JArray())
	{
		var characteristicRow = reference["RowName"]?.ToString();
		var characteristicTable = RefPackage(reference["DataTable"]);
		if (string.IsNullOrEmpty(characteristicRow) || characteristicTable == null) continue;
		var row = LoadExports(characteristicTable)?.FirstOrDefault(e => e["Type"]?.ToString() == "DataTable")?["Rows"]?[characteristicRow];
		if (row == null) continue;
		characteristics.Add(new JObject
		{
			["key"] = characteristicRow,
			["description"] = TextToString(FindRowField(row, "DisplayText")),
		});
	}

	var vehicles = new JArray();
	foreach (var vehicleRef in (props["Vehicles"] as JArray) ?? new JArray())
	{
		var exportName = QuotedName(vehicleRef["ObjectName"])?.Split(':')[^1];
		var availability = exports!.FirstOrDefault(e => e["Name"]?.ToString() == exportName)?["Properties"];
		if (availability == null) continue;
		var settingName = QuotedName(availability["Setting"]?["ObjectName"]) ?? "";
		vehicles.Add(new JObject
		{
			["name"] = settingName,
			["rowName"] = settingName,
			["type"] = settingName,
			["count"] = RestrictionValue(availability["LimitedCount"], "Count", "MaxCount", "Quantity"),
			["delay"] = RestrictionValue(availability["Delay"], "InitialDelay", "Delay"),
			["respawnTime"] = RestrictionValue(availability["Delay"], "RespawnTime", "RespawnDelay"),
			["vehType"] = settingName.Contains('-') ? settingName.Split('-')[^1] : "",
			["spawnerSize"] = "",
			["icon"] = "",
			["classNames"] = new JArray(),
			["tags"] = new JArray(),
			["spawnCommands"] = new JArray(),
		});
	}

	units[rowName] = new JObject
	{
		["unitObjectName"] = rowName,
		["factionName"] = factionNames.GetValueOrDefault(factionId, factionId),
		["factionID"] = factionId,
		["shortName"] = factionId,
		["displayName"] = displayName,
		["description"] = "",
		["unitBadge"] = "",
		["alliance"] = AllianceOf(factionId),
		["actions"] = (props["Actions"] as JArray)?.Count ?? 0,
		["intelOnEnemy"] = props["Intelligence On Enemy"]?.ToObject<double>() ?? props["IntelligenceOnEnemy"]?.ToObject<double>() ?? 0,
		["useCommanderActionNearVehicle"] = props["CanUseCommanderActionNearVehicle"]?.ToObject<bool>() ?? false,
		["hasBuddyRally"] = props["HasBuddyRally"]?.ToObject<bool>() ?? false,
		["roles"] = new JArray(),
		["vehicles"] = vehicles,
		["characteristics"] = characteristics,
	};
}

// ---------------------------------------------------------------- output

var output = new JObject
{
	["DefaultGameSettings"] = new JObject { ["ProjectName"] = "Squad", ["ProjectVersion"] = "extracted" },
	["Maps"] = maps,
	["Units"] = units,
	["Roles"] = new JObject(),
	["MeleeWeapons"] = new JArray(),
};

Console.Error.WriteLine($"extracted {maps.Count} layers, {units.Count} units");
var json = output.ToString(Formatting.Indented);
if (outPath != null)
{
	File.WriteAllText(outPath, json);
	Console.Error.WriteLine($"wrote {outPath}");
}
else
{
	Console.WriteLine(json);
}

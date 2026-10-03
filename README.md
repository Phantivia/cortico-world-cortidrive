# cortico-world-cortidrive

Owner: `src/definition.ts`, `plugin/`.

教可缇开车: Cortico World for *Teach my little sister how to drive* (Steam, Unity Mono build) with the bot in the driver seat. The person in the passenger seat gives instructions by voice through the asr World; the bot drives with `cortidrive_drive` and talks through its VTuber. A BepInEx 5 plugin replaces the game's sister model with the bot's drive tool and serves game events over `127.0.0.1` TCP. The sister version, where the bot instructs and the game's model drives, is `cortico-world-sisterdrive`.

## Install into a game copy

The plugin changes how the game plays (no model, no game voice, no microphone), so it goes into its own copy of the game, not the Steam install or the sisterdrive copy.

1. Copy a game directory that has BepInEx 5.4.23.x installed (next to `teach_sister_to_drive.exe`) outside the Steam library, without `BepInEx/plugins/CorticoSisterDrive.dll`. Add `steam_appid.txt` containing `3950270` next to the exe (Steamworks needs it outside Steam's own launch).
2. `pnpm build:plugin` (needs a .NET 8 SDK; `GameDir` in `plugin/CortiDrivePlugin.csproj` points at the copy and supplies the game assemblies to compile against).
3. Copy `dist/plugin/CorticoCortiDrive.dll` to `<copy>/BepInEx/plugins/`.
4. Start the copy once; `BepInEx/LogOutput.log` shows `listening on 127.0.0.1:47632`. The port lives in `BepInEx/config/ai.cortico.cortidrive.cfg` and must match `worlds.cortidrive.port`.

Set `worlds.cortidrive.gameExe` to the copy's exe; the World page's 游戏 panel (`pnpm build` produces its `dist/console.js`) starts it with Steam running. Both copies share the game's save data under `AppData/LocalLow/tsd`.

## What the World does

- `cortidrive_drive({ steps, action, line })` is one turn of the driver. The game runs it as a reply of its own model, in the stage's own reply format: tutorial actions (`fasten_seatbelt`, `start_engine`, `accelerate`) move the tutorial story; `steps` run as a conditional plan on the car controller (speed km/h, steering -1..1, each step held until seconds / metres / degrees turned / stopped / near the parking goal); `line` is what the bot says, and the game waits about as long as it takes to say it wherever its scripts wait for the sister's line. This covers what the sister model could do: the tutorial actions, the S-lane lever actions (steer, accelerate, brake, reverse), the numeric action sequences of the other stages, and the reply line.
- The game voices nothing and ignores its microphone. Its own scripted sister lines arrive as `script` events for the bot to say.
- Events: `script`, `plan`, `brief`, `mission`, `guide`, `situation`, `popup`, `fine`, `damage`, `illegalAction`, `collision`, `mine`, `emotion`, `stageEnd`, `scene`, plus the live view. Frame fields: [docs/protocol.md](docs/protocol.md).
- `cortidrive_look` returns a screenshot (with a top view) and the current state; `cortidrive_stage` restarts, advances, returns to the menu or continues.

A deployment that runs this World also enables the asr World for the instructor's voice and the vtuber World for the bot's.

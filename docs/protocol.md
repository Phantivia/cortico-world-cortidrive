# Plugin protocol

Owner: `plugin/Plugin.cs`, `plugin/Drive.cs`, `plugin/Patches.cs`, `src/bridge.ts`.

UTF-8 JSON, one frame per line, over TCP on `127.0.0.1:<Port>`. The plugin is the server and serves one client; a new connection replaces the old one. Protocol version: `1`.

## Plugin → World

| kind | fields |
|---|---|
| `hello` | `protocol`, `plugin` (version), `game` (`Application.version`), `state` |
| `reply` | `id` of the request, `ok`, `error` when not ok, request-specific fields |
| `event` | `type`, `scene` (active scene name), `atMs` (game realtime clock), type-specific fields |

`state`: `scene`, `driverInput` (an `AIManager` exists and accepts input), `paused`, `speedUnit`, and when present `seatbelt`/`engine` (tutorial), `speed` (speedometer value), `emotion` (`Smile`/`Angry`/`Anxious`), `fine`, `damageCount`, `context` (what the scene's `AIManager.GetContextInfo()` returns now), `ahead` (nearest non-ground collider on rays from the car straight ahead and 30° left/right within 40 m: `distanceM`, `object`), `goal` (parking TriggerZone relative to the car: `distanceM`, `bearingDeg` right-positive, `inside`, `stayedSec`/`requiredStaySec`, and for rear-in zones `headingErrorDeg`/`allowedErrorDeg`).

Event types and their source:

| type | game method | fields |
|---|---|---|
| `script` | `AiVoiceService.RunTTS` / `RunPreparedTTS` for a line the game wrote itself (not a drive reply line) | `text` |
| `plan` | the plugin's plan runner (see below) | `phase`: `started` (`planId`, `driveId`, `steps`) / `step` (`index`, `count`, `step`) / `done` (`state`) / `cancelled` (`reason`) |
| `brief` | `ModelRouter._activePromptText` changed (polled each second) | `text`: the #Goal and action-scale sections of the sister model's prompt for this stage, verbatim |
| `mission` | `MissionPanel.SetMission` | `text` |
| `guide` | `RoadTestMissionTexts.ShowGuide`, `TutorialUIManager.ShowGuideUI` | `key`, `text` (localized) |
| `situation` | `RoadTestSituationPrompt` / `ParkingSituationPrompt` `OnTriggerEnter` when the player enters | `text` (`prompt2make`) |
| `popup` | `MessagePopup.Show` | `text` |
| `fine` | `ScoreStatus.AddFine` | `amount`, `total` |
| `damage` | `ScoreStatus.AddDamageCount` | `count` |
| `illegalAction` | `IllegalActionTimeoutUI.ShowIllegalActionTimeoutUI` when it was hidden | `timeLeftSec` |
| `collision` | `SLaneCarController.PlayCollisionSound` (S-lane stages score nothing on impact) | `object`, `hit` (`cone`/`hard`), `force`, `state` |
| `mine` | `SLaneMineSceneController.OnMineHit` when the hit count rises | `hits`, `maxHits`, `state` |
| `emotion` | `EmotionStatus.SetEmotion` with a different value | `from`, `to` |
| `stageEnd` | `UIManager.ShowGameOverUI` / `ShowMissionCompleteUI` when neither panel is shown | `result` (`fail`/`clear`), `state`; on fail `cause` (class that called ShowGameOverUI) and `reason` (its `gameOverReason`, when it has one) |
| `scene` | `SceneManager.sceneLoaded` (single mode) | `state` |

## World → Plugin

| kind | fields | reply |
|---|---|---|
| `config` | `id`, `minimap`, `minimapSpanM` (top-right on-screen top view) | — |
| `drive` | `id`, `steps` ([{`speed` km/h, `steer` -1..1, `until`: `seconds`/`distance`/`turned`/`stopped`/`goal`/`none`, `value`}], missing speed/steer = unchanged), `action` (tutorial: `fasten_seatbelt`/`start_engine`/`accelerate`), `line` (what the bot says), `lineSec` (how long it takes to say) | `planId` when steps started, `planRejected: noCarControl` when the car takes no speed/steering; errors `noDriver`, `inputDisabled`, `paused`, `actionOnlyInTutorial`, `unknownAction` |
| `look` | `id`, `maxWidth`, `top`, `topWidth`, `topHeightM`, `topSpanM` | `jpeg` (base64), `width`, `height`, `state`; with `top`: `topJpeg` (orthographic, car heading up), `topSpanM` |
| `stage` | `id`, `action`: `restart`/`next`/`menu`/`continue`, and `newgame` (operator only: New Game from the tutorial) | errors `notInStage`, `noSceneLoader`, `notInMainMenu` |

Every `drive` outside pause also counts as one release of the push-to-talk key (Space, axis `Recording`) for the stage scripts that wait for it (`TutorialController`, `CameraOverviewController`, `ParkingSceneGameManager`); `AIManager` still reads only the real key.

## The bot in the sister model's place

A `drive` is one voice turn of the game. The plugin calls `AIManager.SendAudio2LLM` with a placeholder recording; `ModelRouter.SendAudioAsync` returns, without calling any model, the reply that recording stands for, written in the active scene manager's own format with no action items: `action: <name>\nsister: <line>` (tutorial), `response: <line>` (`DefaultAIManager`, S-lane), JSON `{response, actions: []}` (`RoadDrivingTestManager`), `sister: <line>` (the numeric-action stages). The scene manager handles it as a model reply: tutorial actions and story steps, the reply line, the scripts that wait for that line. An empty line is sent as `…`, since the scripts only move on after a reply line.

The game voices nothing: `AiVoiceService` starts in caption-only mode, so its TTS backend never loads, and `RunTTS`/`RunPreparedTTS` answer at once with `OnTTSPlayFinished(seconds, requestTime)`: `lineSec` for a drive's reply line, the clip length or 4.5 characters a second for the game's own lines (sent as `script` events). The game's microphone input is dropped, the per-minute request limit is off, and the hold-space reminder is suppressed.

## Plans

`steps` run on the player's car controller (`SetTargetSpeed`/`SetSteeringAngle`), each held until its condition is met in game. A later plan cancels the running one, and the scene manager's own `_actionCoroutine` is stopped when a plan starts. The tutorial car has no such controller; there the steps are rejected and `action` drives the story.

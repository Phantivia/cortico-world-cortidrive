using System;
using System.Collections;
using System.Reflection;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace CorticoCortiDrive
{
    /// <summary>
    /// In-game end of the Cortico cortidrive World: the bot drives in the sister model's place.
    /// Frames (JSON lines, see docs/protocol.md): requests from the World carry <c>id</c> and get
    /// one <c>reply</c>; game facts go out as <c>event</c> frames whenever the hooked game method runs.
    /// </summary>
    [BepInPlugin("ai.cortico.cortidrive", "Cortico CortiDrive", Version)]
    public sealed class Plugin : BaseUnityPlugin
    {
        public const string Version = "0.1.0";
        public const int Protocol = 1;

        internal static Plugin Instance;
        internal static ManualLogSource Log;
        internal static string LastContext;

        private ConfigEntry<int> _port;
        private Bridge _bridge;
        private Harmony _harmony;
        private View _view;

        private string _briefedPrompt;
        private float _nextPromptCheck;

        private void Awake()
        {
            Instance = this;
            Log = Logger;
            // The build pauses its player loop while unfocused; the bridge and the game must keep
            // running while the operator works in other windows. Update re-asserts it.
            Application.runInBackground = true;
            _port = Config.Bind("Bridge", "Port", 47632, "127.0.0.1 TCP port the Cortico World connects to.");
            _bridge = new Bridge(_port.Value);
            _harmony = new Harmony("ai.cortico.cortidrive");
            _harmony.PatchAll(typeof(Plugin).Assembly);
            int gated = TalkKey.Install(_harmony);
            _view = new View();
            SceneManager.sceneLoaded += OnSceneLoaded;
            Log.LogInfo($"[cortidrive] listening on 127.0.0.1:{_port.Value}; talk-key gates patched: {gated}");
        }

        private void OnDestroy()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            _bridge?.Dispose();
        }

        private void Update()
        {
            // LoadingSceneManager turns it off when its loading jobs finish.
            if (!Application.runInBackground) Application.runInBackground = true;
            _view.Tick();
            if (Time.unscaledTime >= _nextPromptCheck)
            {
                _nextPromptCheck = Time.unscaledTime + 1f;
                var prompt = ModelRouter.Instance != null ? Traverse.Create(ModelRouter.Instance).Field<string>("_activePromptText").Value : null;
                // The router reloads the same prompt as a new string on reconnects; compare by value.
                if (prompt != null && !string.Equals(prompt, _briefedPrompt, StringComparison.Ordinal))
                {
                    _briefedPrompt = prompt;
                    var brief = Brief();
                    if (brief != null) Event("brief", new JObject { ["text"] = brief });
                }
            }
            while (_bridge.Inbox.TryDequeue(out var frame))
            {
                try { Handle(frame); }
                catch (Exception err)
                {
                    Log.LogError("[cortidrive] request failed: " + err);
                    if (frame["id"] != null) Reply(frame, false, err.GetType().Name + ": " + err.Message);
                }
            }
        }

        // ---- outbound -------------------------------------------------------------------

        internal static void Event(string type, JObject body)
        {
            if (Instance == null) return;
            body["kind"] = "event";
            body["type"] = type;
            body["scene"] = SceneManager.GetActiveScene().name;
            body["atMs"] = (long)(Time.realtimeSinceStartup * 1000);
            Instance._bridge.Send(body);
        }

        private void Reply(JObject req, bool ok, string error = null, JObject body = null)
        {
            var frame = body ?? new JObject();
            frame["kind"] = "reply";
            frame["id"] = req["id"];
            frame["ok"] = ok;
            if (error != null) frame["error"] = error;
            _bridge.Send(frame);
        }

        private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            if (mode != LoadSceneMode.Single) return;
            Drive.Reset();
            Event("scene", new JObject { ["state"] = State() });
        }

        // ---- inbound --------------------------------------------------------------------

        private void Handle(JObject frame)
        {
            switch ((string)frame["kind"])
            {
                case "_connected":
                    _briefedPrompt = null; // the new client gets the current brief within a second
                    _bridge.Send(new JObject
                    {
                        ["kind"] = "hello",
                        ["protocol"] = Protocol,
                        ["plugin"] = Version,
                        ["game"] = Application.version,
                        ["state"] = State(),
                    });
                    break;
                case "config":
                    _view.MinimapEnabled = (bool?)frame["minimap"] ?? true;
                    _view.MinimapSpanMeters = (float?)frame["minimapSpanM"] ?? 60f;
                    Reply(frame, true);
                    break;
                case "drive":
                {
                    var body = Drive.Handle(frame, out var error);
                    if (error != null) Reply(frame, false, error);
                    else Reply(frame, true, null, body);
                    break;
                }
                case "look": StartCoroutine(Look(frame)); break;
                case "stage": Stage(frame); break;
                default: Reply(frame, false, "unknown kind " + (string)frame["kind"]); break;
            }
        }

        private IEnumerator Look(JObject req)
        {
            int maxWidth = (int?)req["maxWidth"] ?? 960;
            yield return new WaitForEndOfFrame();
            Texture2D shot = ScreenCapture.CaptureScreenshotAsTexture();
            Texture2D scaled = shot;
            if (shot.width > maxWidth)
            {
                int height = shot.height * maxWidth / shot.width;
                var rt = RenderTexture.GetTemporary(maxWidth, height);
                Graphics.Blit(shot, rt);
                var prev = RenderTexture.active;
                RenderTexture.active = rt;
                scaled = new Texture2D(maxWidth, height, TextureFormat.RGB24, false);
                scaled.ReadPixels(new Rect(0, 0, maxWidth, height), 0, 0);
                scaled.Apply();
                RenderTexture.active = prev;
                RenderTexture.ReleaseTemporary(rt);
                Destroy(shot);
            }
            var jpeg = scaled.EncodeToJPG(75);
            var body = new JObject
            {
                ["jpeg"] = Convert.ToBase64String(jpeg),
                ["width"] = scaled.width,
                ["height"] = scaled.height,
                ["state"] = State(),
            };
            Destroy(scaled);
            if ((bool?)req["top"] == true)
            {
                var top = _view.RenderTop((int?)req["topWidth"] ?? 512, (float?)req["topHeightM"] ?? 60f, (float?)req["topSpanM"] ?? 60f);
                if (top != null)
                {
                    body["topJpeg"] = Convert.ToBase64String(top.EncodeToJPG(75));
                    body["topSpanM"] = (float?)req["topSpanM"] ?? 60f;
                    Destroy(top);
                }
            }
            Reply(req, true, null, body);
        }

        private void Stage(JObject req)
        {
            string action = (string)req["action"];
            switch (action)
            {
                case "restart":
                    if (GameStatus.Instance == null) { Reply(req, false, "notInStage"); return; }
                    GameStatus.Instance.RestartGame();
                    break;
                case "next":
                {
                    var loader = UnityEngine.Object.FindFirstObjectByType<SceneLoader>();
                    if (loader == null || GameStatus.Instance == null) { Reply(req, false, "notInStage"); return; }
                    loader.LoadNextScene();
                    break;
                }
                case "menu":
                {
                    var loader = UnityEngine.Object.FindFirstObjectByType<SceneLoader>();
                    if (loader == null) { Reply(req, false, "noSceneLoader"); return; }
                    loader.LoadMainMenuScene();
                    break;
                }
                case "continue":
                {
                    var menu = UnityEngine.Object.FindFirstObjectByType<MainMenu>();
                    if (menu == null) { Reply(req, false, "notInMainMenu"); return; }
                    menu.StartContinue();
                    break;
                }
                case "newgame":
                {
                    // Operator-only (the World tool does not offer it): New Game without the confirm panel, from the tutorial.
                    var menu = UnityEngine.Object.FindFirstObjectByType<MainMenu>();
                    if (menu == null) { Reply(req, false, "notInMainMenu"); return; }
                    menu.StartGame();
                    break;
                }
                default: Reply(req, false, "unknown action " + action); return;
            }
            Reply(req, true);
        }

        // ---- state ----------------------------------------------------------------------

        private static readonly BindingFlags AnyInstance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        /// <summary>
        /// Nearest collider straight ahead and 30 degrees to each side, from the car's front,
        /// ignoring the car itself and trigger volumes. Distances in metres; absent when clear within range.
        /// </summary>
        private static JObject Ahead(Transform car)
        {
            const float range = 40f;
            var result = new JObject();
            var origin = car.position + Vector3.up * 0.6f;
            var forward = Vector3.ProjectOnPlane(car.forward, Vector3.up).normalized;
            foreach (var (name, yaw) in new[] { ("front", 0f), ("left", -30f), ("right", 30f) })
            {
                var dir = Quaternion.AngleAxis(yaw, Vector3.up) * forward;
                RaycastHit best = default;
                float bestDist = float.MaxValue;
                foreach (var hit in Physics.RaycastAll(origin, dir, range, ~0, QueryTriggerInteraction.Ignore))
                {
                    if (hit.transform.IsChildOf(car) || hit.distance >= bestDist) continue;
                    // Colliders on layers the car's colliders never collide with (the S-lane's
                    // invisible lane walls) are not obstacles for this car.
                    if (!CarCanHit(car, hit.collider.gameObject.layer)) continue;
                    // ground and road surfaces below the ray origin are not obstacles
                    if (Vector3.Dot(hit.normal, Vector3.up) > 0.8f) continue;
                    best = hit;
                    bestDist = hit.distance;
                }
                if (bestDist < float.MaxValue) result[name] = new JObject { ["distanceM"] = Math.Round(bestDist, 1), ["object"] = best.collider.name };
            }
            return result;
        }

        /// <summary>True when at least one solid collider of the car collides with <paramref name="layer"/> per the physics layer matrix.</summary>
        private static bool CarCanHit(Transform car, int layer)
        {
            foreach (var c in car.GetComponentsInChildren<Collider>())
                if (!c.isTrigger && !Physics.GetIgnoreLayerCollision(c.gameObject.layer, layer)) return true;
            return false;
        }

        /// <summary>
        /// The parking target (TriggerZone) relative to the car, with the quantities its completion
        /// check uses: fully inside, rear-in heading within allowedAngleError, stay time.
        /// </summary>
        internal static JObject GoalOf(Transform car)
        {
            foreach (var zone in UnityEngine.Object.FindObjectsByType<TriggerZone>(FindObjectsSortMode.None))
            {
                var t = Traverse.Create(zone);
                if (t.Field<bool>("isCompleted").Value) continue;
                var local = car.InverseTransformPoint(zone.transform.position);
                var goal = new JObject
                {
                    ["distanceM"] = Math.Round(new Vector2(local.x, local.z).magnitude, 1),
                    ["bearingDeg"] = Math.Round(Mathf.Atan2(local.x, local.z) * Mathf.Rad2Deg),
                    ["inside"] = t.Field<bool>("isFullyInside").Value,
                    ["stayedSec"] = Math.Round(t.Field<float>("currentStayTime").Value, 1),
                    ["requiredStaySec"] = t.Field<float>("requiredStayTime").Value,
                };
                var reference = t.Field<Transform>("parkingDirectionReference").Value;
                if (reference != null)
                {
                    goal["rearIn"] = true;
                    goal["headingErrorDeg"] = Math.Round(180f - Vector3.Angle(car.forward, reference.forward));
                    goal["allowedErrorDeg"] = t.Field<float>("allowedAngleError").Value;
                }
                return goal;
            }
            return null;
        }

        /// <summary>
        /// The parts of the sister model's system prompt for this stage that state the stage goal
        /// and the action scale (#Goal, ##target_speed, ##steering_angle, ##duration, lever actions), verbatim.
        /// </summary>
        internal static string Brief()
        {
            if (ModelRouter.Instance == null) return null;
            var prompt = Traverse.Create(ModelRouter.Instance).Field<string>("_activePromptText").Value;
            if (string.IsNullOrEmpty(prompt)) return null;
            var parts = new System.Collections.Generic.List<string>();
            foreach (var header in new[] { "#Goal", "##target_speed", "##steering_angle", "##duration", "##horizontal_action", "##vertical_action" })
            {
                int at = prompt.IndexOf(header + "\n", StringComparison.Ordinal);
                if (at < 0) at = prompt.IndexOf(header, StringComparison.Ordinal);
                if (at < 0) continue;
                int end = prompt.IndexOf("\n#", at + header.Length, StringComparison.Ordinal);
                parts.Add((end < 0 ? prompt.Substring(at) : prompt.Substring(at, end - at)).Trim());
            }
            return parts.Count > 0 ? string.Join("\n", parts) : null;
        }

        internal static JObject State()
        {
            var state = new JObject { ["scene"] = SceneManager.GetActiveScene().name };
            var manager = AIManager.Instance;
            state["driverInput"] = manager != null && manager.InputAvailable;
            state["paused"] = GameStatus.Instance != null && GameStatus.Instance.IsPaused();
            state["speedUnit"] = PlayerPrefs.GetInt("IsMileUnit", 0) == 1 ? "mph" : "km/h";
            if (manager is TutorialController tutorial)
            {
                var t = Traverse.Create(tutorial);
                state["seatbelt"] = t.Field<bool>("_isSeatbeltFasten").Value;
                state["engine"] = t.Field<bool>("_isEngineStarted").Value;
            }
            var player = GameObject.FindGameObjectWithTag("Player");
            var rb = player != null ? player.GetComponent<Rigidbody>() : null;
            // Same formula as the speedometer (VehicleStatusUI).
            if (rb != null) state["speed"] = Mathf.RoundToInt(rb.linearVelocity.magnitude * 4f);
            if (player != null)
            {
                var goal = GoalOf(player.transform);
                if (goal != null) state["goal"] = goal;
                state["ahead"] = Ahead(player.transform);
            }
            if (EmotionStatus.Instance != null) state["emotion"] = EmotionStatus.Instance.GetEmotion().ToString();
            if (ScoreStatus.Instance != null)
            {
                state["fine"] = ScoreStatus.Instance.GetFine();
                state["damageCount"] = ScoreStatus.Instance.GetDamageCount();
            }
            if (manager != null)
            {
                var getContext = manager.GetType().GetMethod("GetContextInfo", AnyInstance, null, Type.EmptyTypes, null);
                if (getContext != null)
                {
                    try { state["context"] = (string)getContext.Invoke(manager, null); }
                    catch (Exception err) { state["contextError"] = (err.InnerException ?? err).Message; }
                }
            }
            return state;
        }
    }
}

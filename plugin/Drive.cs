using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using HarmonyLib;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace CorticoCortiDrive
{
    /// <summary>
    /// The bot takes the sister model's place. A drive request becomes one voice turn of the game:
    /// the plugin hands AIManager.SendAudio2LLM a placeholder recording, and the router returns
    /// the bot's reply, written in the active scene manager's own reply format, instead of asking
    /// a model. Everything after that is the game's own handling of a model reply: the tutorial's
    /// actions and story steps, the reply line and the scripts that wait for it. Speed and
    /// steering come as a plan (<see cref="Plan"/>) and run on the car controller.
    /// </summary>
    internal static class Drive
    {
        /// <summary>Tutorial action names the bot may send; the tutorial treats any other name as no action.</summary>
        internal static readonly string[] TutorialActions = { "fasten_seatbelt", "start_engine", "accelerate" };

        /// <summary>The reply each placeholder recording stands for.</summary>
        internal static readonly ConditionalWeakTable<byte[], string> Replies = new ConditionalWeakTable<byte[], string>();

        /// <summary>Reply lines handed to the game and how long the bot takes to say them; RunTTS takes them out.</summary>
        private static readonly Dictionary<string, float> Lines = new Dictionary<string, float>();

        /// <summary>The reply line the game requires when the bot says nothing; it is never voiced.</summary>
        private const string Silent = "…";

        internal static bool Injecting;

        internal static void Reset() => Lines.Clear();

        /// <summary>Handles a drive request; returns the reply body, or an error code in <paramref name="error"/>.</summary>
        internal static JObject Handle(JObject req, out string error)
        {
            error = null;
            if (GameStatus.Instance != null && GameStatus.Instance.IsPaused()) { error = "paused"; return null; }
            var steps = Plan.Parse(req["steps"] as JArray);
            string action = (string)req["action"];
            // The talk key counts as released whether or not the game takes the turn, as with the real key.
            TalkKey.Release();
            var manager = AIManager.Instance;
            if (manager == null) { error = "noDriver"; return null; }
            if (!manager.InputAvailable) { error = "inputDisabled"; return null; }
            bool tutorial = manager is TutorialController;
            if (action != null && (!tutorial || Array.IndexOf(TutorialActions, action) < 0)) { error = tutorial ? "unknownAction" : "actionOnlyInTutorial"; return null; }

            string line = Clean((string)req["line"]);
            if (line.Length == 0) line = Silent;
            Lines[line] = line == Silent ? 0f : (float?)req["lineSec"] ?? 0f;
            var wav = Placeholder();
            Replies.Add(wav, ReplyFor(manager, action, line));
            long driveId = (long?)req["id"] ?? 0;
            Injecting = true;
            try { manager.SendAudio2LLM(wav); }
            finally { Injecting = false; }

            var body = new JObject();
            if (steps.Count > 0)
            {
                int planId = Plan.Start(steps, driveId);
                if (planId > 0) body["planId"] = planId;
                else body["planRejected"] = "noCarControl";
            }
            return body;
        }

        /// <summary>The reply as the active scene manager parses it; no action items, so its own action handling does nothing.</summary>
        private static string ReplyFor(AIManager manager, string action, string line)
        {
            switch (manager)
            {
                case TutorialController _:
                    return (action != null ? "action: " + action + "\n" : "") + "sister: " + line;
                case DefaultAIManager _:
                    return "response: " + line;
                case RoadDrivingTestManager _:
                    return JsonConvert.SerializeObject(new { response = line, actions = new object[0] });
                default:
                    return "sister: " + line;
            }
        }

        /// <summary>One line, without the brackets and labels the scene parsers look for.</summary>
        private static string Clean(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return "";
            var chars = new System.Text.StringBuilder(line.Length);
            foreach (var c in line)
            {
                if (c == '[' || c == ']' || c == '{' || c == '}') continue;
                chars.Append(char.IsWhiteSpace(c) ? ' ' : c);
            }
            return chars.ToString().Replace("brother:", "").Replace("sister:", "").Replace("response:", "").Trim();
        }

        /// <summary>A minimal RIFF header: the voice entry only checks that the recording is not empty.</summary>
        private static byte[] Placeholder()
        {
            var wav = new byte[44];
            System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(wav, 0);
            System.Text.Encoding.ASCII.GetBytes("WAVE").CopyTo(wav, 8);
            return wav;
        }

        /// <summary>True when <paramref name="text"/> is a reply line the bot supplied; <paramref name="sec"/> is its speaking time.</summary>
        internal static bool TakeLine(string text, out float sec)
        {
            if (text != null && Lines.TryGetValue(text, out sec)) { Lines.Remove(text); return true; }
            sec = 0f;
            return false;
        }
    }

    /// <summary>Only drive requests reach the game's turn handling; the game's own microphone input is dropped.</summary>
    [HarmonyPatch(typeof(AIManager), nameof(AIManager.SendAudio2LLM))]
    internal static class MicDropPatch
    {
        private static bool Prefix() => Drive.Injecting;
    }

    /// <summary>The request limit guards model calls; no model is called.</summary>
    [HarmonyPatch(typeof(AIManager), "CheckRequestLimitReached")]
    internal static class NoRateLimitPatch
    {
        private static bool Prefix(ref bool __result)
        {
            __result = false;
            return false;
        }
    }

    [HarmonyPatch(typeof(AIManager), "SendToLlmAsync")]
    internal static class ContextPatch
    {
        private static void Prefix(string context) => Plugin.LastContext = context;
    }

    /// <summary>The router answers with the bot's reply for that recording and never calls a model.</summary>
    [HarmonyPatch(typeof(ModelRouter), nameof(ModelRouter.SendAudioAsync))]
    internal static class RouterPatch
    {
        private static bool Prefix(byte[] wav, ref Awaitable<string> __result)
        {
            string reply = null;
            if (wav != null) Drive.Replies.TryGetValue(wav, out reply);
            __result = Answer(reply);
            return false;
        }

#pragma warning disable CS1998 // completes synchronously by design
        private static async Awaitable<string> Answer(string reply) => reply;
#pragma warning restore CS1998
    }

    /// <summary>
    /// The sister's voice is the bot's own (its VTuber speech), so the game synthesizes nothing:
    /// caption-only mode keeps the game's TTS backend from loading. Every line the game would
    /// voice is answered at once with OnTTSPlayFinished(duration), which is what scripts that
    /// wait for a line listen to. Lines the game wrote itself (intro, reminders before a stage)
    /// go to the World as <c>script</c> events.
    /// </summary>
    internal static class Voice
    {
        /// <summary>Speaking time the scripts wait after a line of the game's own, at about 4.5 characters a second.</summary>
        internal static float Estimate(string text) => string.IsNullOrEmpty(text) ? 0f : Mathf.Clamp(text.Length / 4.5f, 1f, 12f);

        internal static void Finished(float sec, float requestTime)
        {
            var service = AiVoiceService.Instance;
            if (service == null) return;
            var handler = AccessTools.Field(typeof(AiVoiceService), "OnTTSPlayFinished").GetValue(service) as Action<float, float>;
            handler?.Invoke(sec, requestTime);
        }
    }

    [HarmonyPatch(typeof(AiVoiceService), "Awake")]
    internal static class CaptionOnlyPatch
    {
        private static void Prefix(ref bool ____captionOnly) => ____captionOnly = true;
    }

    [HarmonyPatch(typeof(AiVoiceService), nameof(AiVoiceService.RunTTS))]
    internal static class LinePatch
    {
        private static bool Prefix(string text, float? requestTime)
        {
            float at = requestTime ?? Time.realtimeSinceStartup;
            if (Drive.TakeLine(text, out var sec))
            {
                Voice.Finished(sec, at);
                return false;
            }
            Plugin.Event("script", new JObject { ["text"] = text });
            Voice.Finished(Voice.Estimate(text), at);
            return false;
        }
    }

    [HarmonyPatch(typeof(AiVoiceService), nameof(AiVoiceService.RunPreparedTTS))]
    internal static class PreparedLinePatch
    {
        private static bool Prefix(AudioClip clip, string subtitle, float? requestTime, ref float __result)
        {
            float at = requestTime ?? Time.realtimeSinceStartup;
            Plugin.Event("script", new JObject { ["text"] = subtitle });
            Voice.Finished(clip != null ? clip.length : Voice.Estimate(subtitle), at);
            __result = at;
            return false;
        }
    }

    /// <summary>The reminder asks the player to hold the talk key; nobody talks to the game through it here.</summary>
    [HarmonyPatch(typeof(SpaceHoldReminder), "PlayVoiceReminder")]
    internal static class NoVoiceReminderPatch
    {
        private static bool Prefix() => false;
    }

    [HarmonyPatch(typeof(SpaceHoldReminder), "ShowGuide")]
    internal static class NoReminderGuidePatch
    {
        private static bool Prefix() => false;
    }
}

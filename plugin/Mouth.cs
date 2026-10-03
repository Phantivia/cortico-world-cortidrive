using System.Collections.Generic;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace CorticoCortiDrive
{
    /// <summary>
    /// The sister's mouth (Mumbling, MumblingBlendShapeSystem) opens and closes while their audio
    /// source is playing; the game has no other lip sync. The World sends the windows in which the
    /// bot's own voice is speaking; during them those audio sources play a silent loop, so the
    /// mouth moves with the bot's voice and the game stays silent.
    /// </summary>
    internal static class Mouth
    {
        private struct Window
        {
            public float From;
            public float To;
        }

        private static readonly List<Window> Windows = new List<Window>();
        private static readonly List<AudioSource> Sources = new List<AudioSource>();
        private static AudioClip _silence;
        private static float _nextFind;

        /// <summary>Replaces the speaking windows: [{atMs, ms}], atMs relative to now (negative = already started).</summary>
        internal static void Set(JArray windows)
        {
            Windows.Clear();
            float now = Time.realtimeSinceStartup;
            if (windows == null) return;
            foreach (var token in windows)
            {
                float at = ((float?)token["atMs"] ?? 0f) / 1000f;
                float ms = ((float?)token["ms"] ?? 0f) / 1000f;
                if (ms > 0f) Windows.Add(new Window { From = now + at, To = now + at + ms });
            }
        }

        /// <summary>The mouth components look up their audio source in Start; they are found again after each scene load.</summary>
        internal static void SceneLoaded()
        {
            Sources.Clear();
        }

        internal static void Tick()
        {
            float now = Time.realtimeSinceStartup;
            bool speaking = false;
            foreach (var w in Windows)
                if (now >= w.From && now < w.To) { speaking = true; break; }
            if (!speaking && Windows.Count > 0 && Windows.TrueForAll(w => now >= w.To)) Windows.Clear();
            // The mouth may appear after speech starts (car spawns late); look again at most once a second.
            if (speaking && Sources.Count == 0 && now >= _nextFind) { _nextFind = now + 1f; FindSources(); }
            foreach (var source in Sources)
            {
                if (source == null) continue;
                bool ours = source.clip == Silence();
                if (speaking && !(ours && source.isPlaying))
                {
                    source.clip = Silence();
                    source.loop = true;
                    source.Play();
                }
                else if (!speaking && ours && source.isPlaying)
                {
                    source.Stop();
                    source.loop = false;
                }
            }
        }

        private static void FindSources()
        {
            foreach (var m in Object.FindObjectsByType<Mumbling>(FindObjectsSortMode.None))
                Add(Traverse.Create(m).Field<AudioSource>("_mouthAudio").Value);
            foreach (var m in Object.FindObjectsByType<MumblingBlendShapeSystem>(FindObjectsSortMode.None))
                Add(Traverse.Create(m).Field<AudioSource>("mouthAudio").Value);
        }

        private static void Add(AudioSource source)
        {
            if (source != null && !Sources.Contains(source)) Sources.Add(source);
        }

        private static AudioClip Silence()
        {
            if (_silence == null)
            {
                // A new clip holds zeros: 0.1 s of silence, looped.
                _silence = AudioClip.Create("CorticoMouthSilence", 4410, 1, 44100, false);
            }
            return _silence;
        }
    }
}

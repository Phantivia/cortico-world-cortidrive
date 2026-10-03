using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace CorticoCortiDrive
{
    /// <summary>
    /// Conditional plans sent by the World: each step sets speed and steering on the scene's car
    /// controller and holds until its condition is met in game; then the next step starts. A new
    /// plan cancels the running one, as a new instruction does in the game.
    /// </summary>
    internal static class Plan
    {
        internal sealed class Step
        {
            public float? Speed;
            public float? Steer;
            public string Until = "none";
            public float Value;
        }

        internal static readonly string[] Conditions = { "seconds", "distance", "turned", "stopped", "goal", "none" };

        private static Coroutine _running;
        private static int _planId;

        /// <summary>Steps from the request's <c>steps</c> array: {speed?, steer?, until?, value?}; a missing speed or steer keeps the current one.</summary>
        internal static List<Step> Parse(JArray steps)
        {
            var list = new List<Step>();
            if (steps == null) return list;
            foreach (var token in steps)
            {
                if (!(token is JObject o)) throw new ArgumentException("step must be an object");
                var s = new Step
                {
                    Speed = (float?)o["speed"],
                    Steer = (float?)o["steer"],
                    Until = ((string)o["until"] ?? "none").ToLowerInvariant(),
                    Value = (float?)o["value"] ?? 0f,
                };
                if (s.Steer.HasValue) s.Steer = Mathf.Clamp(s.Steer.Value, -1f, 1f);
                if (Array.IndexOf(Conditions, s.Until) < 0) throw new ArgumentException("unknown until " + s.Until);
                list.Add(s);
            }
            return list;
        }

        internal static void Cancel(string reason)
        {
            if (_running == null) return;
            Plugin.Instance.StopCoroutine(_running);
            _running = null;
            Plugin.Event("plan", new JObject { ["phase"] = "cancelled", ["planId"] = _planId, ["reason"] = reason });
        }

        /// <summary>Starts the plan; 0 when the player car takes no speed/steering control (no car, the tutorial car).</summary>
        internal static int Start(List<Step> steps, long driveId)
        {
            var player = GameObject.FindGameObjectWithTag("Player");
            if (player == null || Controller(player) == null) return 0;
            Cancel("replaced");
            // The scene manager's own action sequence stops too.
            var manager = AIManager.Instance;
            if (manager != null)
            {
                var field = AccessTools.Field(manager.GetType(), "_actionCoroutine");
                if (field?.GetValue(manager) is Coroutine c) { manager.StopCoroutine(c); field.SetValue(manager, null); }
            }
            _planId++;
            var list = new JArray();
            foreach (var s in steps) list.Add(Describe(s));
            Plugin.Event("plan", new JObject { ["phase"] = "started", ["planId"] = _planId, ["driveId"] = driveId, ["steps"] = list });
            _running = Plugin.Instance.StartCoroutine(Run(steps, _planId));
            return _planId;
        }

        private static string Describe(Step s) =>
            $"speed {(s.Speed.HasValue ? s.Speed.Value.ToString(CultureInfo.InvariantCulture) : "none")}, steer {(s.Steer.HasValue ? s.Steer.Value.ToString(CultureInfo.InvariantCulture) : "none")}, until {s.Until}{(s.Until is "seconds" or "distance" or "turned" or "goal" ? " " + s.Value.ToString(CultureInfo.InvariantCulture) : "")}";

        private static IEnumerator Run(List<Step> steps, int planId)
        {
            for (int i = 0; i < steps.Count; i++)
            {
                var step = steps[i];
                var player = GameObject.FindGameObjectWithTag("Player");
                if (player == null) { _running = null; yield break; }
                Apply(player, step);
                Plugin.Event("plan", new JObject { ["phase"] = "step", ["planId"] = planId, ["index"] = i + 1, ["count"] = steps.Count, ["step"] = Describe(step) });
                if (step.Until == "none") break;
                var car = player.transform;
                var rb = player.GetComponent<Rigidbody>();
                Vector3 last = car.position;
                float lastYaw = car.eulerAngles.y, distance = 0f, turned = 0f, started = Time.time;
                while (true)
                {
                    yield return null;
                    if (car == null) { _running = null; yield break; }
                    var p = car.position;
                    distance += new Vector2(p.x - last.x, p.z - last.z).magnitude;
                    turned += Mathf.Abs(Mathf.DeltaAngle(lastYaw, car.eulerAngles.y));
                    last = p;
                    lastYaw = car.eulerAngles.y;
                    if (Done(step, Time.time - started, distance, turned, rb, car)) break;
                }
            }
            _running = null;
            Plugin.Event("plan", new JObject { ["phase"] = "done", ["planId"] = planId, ["state"] = Plugin.State() });
        }

        private static bool Done(Step step, float elapsed, float distance, float turned, Rigidbody rb, Transform car)
        {
            switch (step.Until)
            {
                case "seconds": return elapsed >= step.Value;
                case "distance": return distance >= step.Value;
                case "turned": return turned >= step.Value;
                case "stopped": return elapsed > 0.5f && rb != null && rb.linearVelocity.magnitude < 0.3f;
                case "goal":
                    var goal = Plugin.GoalOf(car);
                    return goal != null && (double)goal["distanceM"] <= step.Value;
                default: return true;
            }
        }

        /// <summary>The player's car controller: the component with SetTargetSpeed(float[, bool]) and SetSteeringAngle(float).</summary>
        private static MonoBehaviour Controller(GameObject player)
        {
            foreach (var mb in player.GetComponents<MonoBehaviour>())
                if (SetSpeed(mb.GetType()) != null && SetSteer(mb.GetType()) != null) return mb;
            return null;
        }

        private static MethodInfo SetSpeed(Type type) =>
            type.GetMethods(BindingFlags.Instance | BindingFlags.Public).FirstOrDefault(m => m.Name == "SetTargetSpeed" && m.GetParameters().Length >= 1 && m.GetParameters()[0].ParameterType == typeof(float));

        private static MethodInfo SetSteer(Type type) =>
            type.GetMethod("SetSteeringAngle", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(float) }, null);

        /// <summary>Speed and steering go through the scene's car controller, as the game's own actions do.</summary>
        private static void Apply(GameObject player, Step step)
        {
            var mb = Controller(player);
            if (mb == null) return;
            if (step.Speed.HasValue)
            {
                var setSpeed = SetSpeed(mb.GetType());
                var args = setSpeed.GetParameters().Length == 2 ? new object[] { step.Speed.Value, step.Steer.HasValue && step.Steer.Value != 0f } : new object[] { step.Speed.Value };
                setSpeed.Invoke(mb, args);
            }
            if (step.Steer.HasValue) SetSteer(mb.GetType()).Invoke(mb, new object[] { step.Steer.Value });
        }
    }
}

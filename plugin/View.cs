using UnityEngine;

namespace CorticoCortiDrive
{
    /// <summary>
    /// Top view: plugin-owned cameras above the player car, heading up. One draws the minimap in
    /// the top-right corner of the screen; another renders on demand into a texture for screenshots.
    /// </summary>
    internal sealed class View
    {
        internal bool MinimapEnabled = true;
        internal float MinimapSpanMeters = 60f;

        private Camera _topCamera;
        private Camera _miniCamera;

        // Minimap viewport: share of screen width, margin from the top-right corner.
        private const float MinimapWidth = 0.22f;
        private const float MinimapMargin = 0.015f;
        private const float MinimapHeightMeters = 60f;

        /// <summary>On-screen top view in the top-right corner, following the player car heading up.</summary>
        internal void Tick()
        {
            var player = MinimapEnabled ? GameObject.FindGameObjectWithTag("Player") : null;
            if (player == null)
            {
                if (_miniCamera != null) _miniCamera.enabled = false;
                return;
            }
            if (_miniCamera == null)
            {
                var go = new GameObject("CorticoMinimap") { hideFlags = HideFlags.HideAndDontSave };
                Object.DontDestroyOnLoad(go);
                _miniCamera = go.AddComponent<Camera>();
                _miniCamera.orthographic = true;
                _miniCamera.clearFlags = CameraClearFlags.Skybox;
                _miniCamera.nearClipPlane = 0.3f;
                _miniCamera.depth = 100;
            }
            _miniCamera.enabled = true;
            float aspect = (float)Screen.width / Mathf.Max(1, Screen.height);
            float h = MinimapWidth * aspect;
            _miniCamera.rect = new Rect(1f - MinimapWidth - MinimapMargin, 1f - h - MinimapMargin * aspect, MinimapWidth, h);
            _miniCamera.orthographicSize = MinimapSpanMeters / 2f;
            _miniCamera.farClipPlane = MinimapHeightMeters + 50f;
            _miniCamera.transform.SetPositionAndRotation(AheadOf(player.transform, MinimapSpanMeters) + Vector3.up * MinimapHeightMeters, Quaternion.Euler(90f, player.transform.eulerAngles.y, 0f));
        }

        /// <summary>View centre a quarter span ahead of the car, so the car sits in the lower quarter.</summary>
        private static Vector3 AheadOf(Transform car, float spanMeters)
        {
            var forward = Vector3.ProjectOnPlane(car.forward, Vector3.up).normalized;
            return car.position + forward * (spanMeters / 4f);
        }

        /// <summary>Renders the top view into a new texture; null when there is no player car.</summary>
        internal Texture2D RenderTop(int width, float heightMeters, float spanMeters)
        {
            var player = GameObject.FindGameObjectWithTag("Player");
            if (player == null) return null;
            if (_topCamera == null)
            {
                var go = new GameObject("CorticoTopView") { hideFlags = HideFlags.HideAndDontSave };
                Object.DontDestroyOnLoad(go);
                _topCamera = go.AddComponent<Camera>();
                _topCamera.enabled = false;
                _topCamera.orthographic = true;
                _topCamera.clearFlags = CameraClearFlags.Skybox;
                _topCamera.nearClipPlane = 0.3f;
            }
            int height = width;
            _topCamera.transform.SetPositionAndRotation(AheadOf(player.transform, spanMeters) + Vector3.up * heightMeters, Quaternion.Euler(90f, player.transform.eulerAngles.y, 0f));
            _topCamera.farClipPlane = heightMeters + 50f;
            _topCamera.orthographicSize = spanMeters / 2f;
            var rt = RenderTexture.GetTemporary(width, height, 24);
            _topCamera.targetTexture = rt;
            _topCamera.Render();
            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;
            _topCamera.targetTexture = null;
            RenderTexture.ReleaseTemporary(rt);
            return tex;
        }
    }
}

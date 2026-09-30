/**
 * withOptionalCamera — declare the camera as OPTIONAL hardware.
 *
 * The CAMERA permission (expo-camera for the pairing QR, expo-image-picker for
 * receipts) makes Android / F-Droid infer a REQUIRED android.hardware.camera, so a
 * device without one (or without autofocus) is told KYM is "not compatible". Both
 * uses already degrade (paste the code / pick a photo), so mark the features
 * required="false". Survives `expo prebuild --clean` (lives in app.json plugins).
 */
const { withAndroidManifest } = require("@expo/config-plugins");

const FEATURES = ["android.hardware.camera", "android.hardware.camera.autofocus", "android.hardware.camera.any"];

module.exports = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const list = (manifest["uses-feature"] = manifest["uses-feature"] || []);
    for (const name of FEATURES) {
      const existing = list.find((f) => f.$ && f.$["android:name"] === name);
      if (existing) existing.$["android:required"] = "false";
      else list.push({ $: { "android:name": name, "android:required": "false" } });
    }
    return cfg;
  });

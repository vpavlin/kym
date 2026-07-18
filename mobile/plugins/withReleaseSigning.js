/**
 * withReleaseSigning — sign KYM release builds with the real KYM key.
 *
 * Expo's template signs BOTH debug and release with the checked-in debug
 * keystore (the well-known, shared Android debug key — anyone could sign an APK
 * your phone accepts as a KYM update). Android identifies an app by its signing
 * cert, so the key can never be rotated after publishing.
 *
 * Credentials are NOT in this repo. They live in ~/.gradle/gradle.properties:
 *   KYM_STORE_FILE=/home/<you>/keystores/kym-release.jks
 *   KYM_STORE_PASSWORD=…   KYM_KEY_ALIAS=kym   KYM_KEY_PASSWORD=…
 * If absent (fresh clone / CI without secrets) the build falls back to the debug
 * key rather than failing — and CI must never carry the key.
 */
const { withAppBuildGradle } = require("@expo/config-plugins");

const RELEASE_SIGNING_CONFIG = `
        release {
            // Credentials come from ~/.gradle/gradle.properties (outside this repo).
            if (project.hasProperty('KYM_STORE_FILE')) {
                storeFile file(project.property('KYM_STORE_FILE'))
                storePassword project.property('KYM_STORE_PASSWORD')
                keyAlias project.property('KYM_KEY_ALIAS')
                keyPassword project.property('KYM_KEY_PASSWORD')
            }
        }`;

module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let s = cfg.modResults.contents;
    if (!s.includes("KYM_STORE_FILE")) {
      const before = s;
      s = s.replace(/(signingConfigs\s*\{)/, `$1${RELEASE_SIGNING_CONFIG}`);
      if (s === before) throw new Error("withReleaseSigning: signingConfigs block not found");

      const anchor =
        /(\/\/ Caution! In production[^\n]*\n\s*\/\/ see [^\n]*\n\s*)signingConfig signingConfigs\.debug/;
      if (!anchor.test(s)) throw new Error("withReleaseSigning: release buildType anchor not found");
      s = s.replace(
        anchor,
        `$1signingConfig project.hasProperty('KYM_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`
      );
      cfg.modResults.contents = s;
    }
    return cfg;
  });

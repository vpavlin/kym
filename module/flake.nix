{
  description = "KYM — Logos Basecamp ui_qml budget module (C++ event-log engine + QML grid)";

  inputs = {
    # Pinned to the SAME logos-module-builder rev Perun uses against the deployed
    # 0.2.0 Basecamp (builder rev 021013458d87, 2026-06-17) — a known-good SDK.
    logos-module-builder.url = "github:logos-co/logos-module-builder/021013458d87ba871e1d80ff2e70d8dda331606d";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}

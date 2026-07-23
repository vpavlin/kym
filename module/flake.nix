{
  description = "KYM — Logos Basecamp ui_qml budget module (C++ event-log engine + QML grid)";

  inputs = {
    # Sync transport — same delivery_module Perun ships on (payloads base64 over
    # FFI, Waku 150 KB/msg; we connect to the logos.dev preset fleet).
    delivery_module.url = "github:logos-co/logos-delivery-module/v0.1.3";
    # Pinned to the SAME logos-module-builder rev Perun uses against the deployed
    # 0.2.0 Basecamp (builder rev 021013458d87, 2026-06-17) — a known-good SDK.
    # delivery_module follows it so both build against one SDK (avoids the
    # cross-module IPC skew Perun documented).
    logos-module-builder.url = "github:logos-co/logos-module-builder/021013458d87ba871e1d80ff2e70d8dda331606d";
    delivery_module.inputs.logos-module-builder.follows = "logos-module-builder";
    # The KYM engine/sync CORE module — this ui module is a thin view over it.
    kym_core.url = "path:../kym_core";
    kym_core.inputs.logos-module-builder.follows = "logos-module-builder";
    kym_core.inputs.delivery_module.follows = "delivery_module";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}

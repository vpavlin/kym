{
  description = "KYM — Logos Basecamp ui_qml budget module (C++ event-log engine + QML grid)";

  inputs = {
    # port/0.3: builder 0.3.1 — the same builder as kym_core and loam_core (one SDK).
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    kym_core.url = "github:vpavlin/kym/3fd4b64376eefc6b955e5d5a6407d60430fb9cc6?dir=kym_core";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}

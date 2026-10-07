{
  description = "KYM engine + sync CORE module (engine + crypto + delivery); headless hub AND the desktop ui backend.";

  inputs = {
    # port/0.3: builder 0.3.1; kym_core rides the loam_core facade on UPSTREAM delivery v0.3.0.
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    loam_core.url = "github:vpavlin/loam-basecamp/553253fee586baeb16d84c77e3f6da543ba7de9b?dir=core";
  };

  # mkLogosModule (not mkLogosQmlModule): a headless core module — no QML view,
  # the plugin glue is generated from src/kym_hub_impl.h (universal authoring).
  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}

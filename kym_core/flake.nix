{
  description = "KYM engine + sync CORE module (engine + crypto + delivery); headless hub AND the desktop ui backend.";

  inputs = {
    # Same pinned SDK rev + delivery_module version as module/flake.nix, so the
    # hub and the desktop/mobile peers build against one SDK (avoids IPC skew).
    delivery_module.url = "github:logos-co/logos-delivery-module/v0.1.3";
    logos-module-builder.url = "github:logos-co/logos-module-builder/afe4430ee6eb";
    delivery_module.inputs.logos-module-builder.follows = "logos-module-builder";
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

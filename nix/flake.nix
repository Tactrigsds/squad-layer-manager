{
  # The toolchain that builds and runs this app outside the production image: node and corepack, the rust toolchain
  # the layer engine compiles through, the C toolchain node-gyp needs for better-sqlite3, and the .NET SDK the layer
  # extractor builds with. The dev shell adds the shared libraries the browser Playwright downloads links against.
  # The dev container installs `packages.devcontainer-tools` instead. See CONTRIBUTING.md.
  #
  #   nix develop path:./nix -c pnpm dev
  #
  # `path:` copies only this directory into the store. Without it, nix copies every tracked file in the repo.
  description = "Build and dev-mode dependencies for squad-layer-manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # The last nixos-unstable revision with node 24.18.0, the version the production image and .tool-versions pin.
    # Bump the two together.
    nixpkgs-node.url = "github:NixOS/nixpkgs/ed7a5b3882d62c054e84323e6d60cac650d136ee";
  };

  outputs = { nixpkgs, nixpkgs-node, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system} nixpkgs-node.legacyPackages.${system});

      tools = pkgs: nodePkgs: [
        # corepack over a pnpm package, so the version comes from package.json's `packageManager`
        nodePkgs.nodejs_24
        nodePkgs.corepack_24

        # `pnpm run build:engine`. The wasm32-unknown-unknown std ships with nixpkgs' rustc, but the bundled
        # rust-lld does not: that rustc links the target through whatever `lld` is on PATH.
        pkgs.cargo
        pkgs.lld
        pkgs.rustc

        # node-gyp, which better-sqlite3 falls back to when there is no prebuild for the running node. The
        # compiler has to link against the same glibc as the node above, or the built module will not load.
        pkgs.stdenv.cc
        pkgs.gnumake
        pkgs.python3

        # tools/layer-extractor, which reads layer data out of the cooked game files (see docs/layer_data.md)
        pkgs.dotnet-sdk_10
      ];

      # The chrome-headless-shell that `playwright install` downloads is a prebuilt FHS binary, so it starts and
      # then dies on the first library it cannot find. Supplying these rather than nixpkgs'
      # playwright-driver.browsers leaves Playwright managing its own downloads, so nothing here has to be kept in
      # step with the @playwright/test the repo pins. The dev container installs them from apt instead.
      browserLibs = pkgs: with pkgs; [
        alsa-lib
        at-spi2-atk
        at-spi2-core
        atk
        cairo
        cups
        dbus
        expat
        glib
        libdrm
        libgbm
        libx11
        libxcb
        libxcomposite
        libxdamage
        libxext
        libxfixes
        libxkbcommon
        libxrandr
        nspr
        nss
        pango
        systemd
      ];
    in
    {
      devShells = forAllSystems (pkgs: nodePkgs: {
        default = pkgs.mkShell {
          packages = tools pkgs nodePkgs;
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (browserLibs pkgs);
        };
      });

      packages = forAllSystems (pkgs: nodePkgs: {
        devcontainer-tools = pkgs.buildEnv {
          name = "slm-devcontainer-tools";
          paths = tools pkgs nodePkgs;
        };
      });
    };
}

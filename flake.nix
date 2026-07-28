{
  description = "Jekyll blog for GitHub Pages — dev shell with Ruby, Bundler and Jekyll";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        ruby = pkgs.ruby_3_3;
      in
      {
        devShells.default = pkgs.mkShell {
          name = "blog";

          packages = with pkgs; [
            ruby
            bundler          # `bundle install` / `bundle exec jekyll serve`
            libyaml          # psych
            zlib             # nokogiri, rouge deps
            libffi           # ffi (used by listen/jekyll-watch)
            openssl
            pkg-config
            gcc
            gnumake
            git
          ];

          # Gems land in ./.gems so nothing is written outside the repo.
          shellHook = ''
            export GEM_HOME="$PWD/.gems"
            export BUNDLE_PATH="$GEM_HOME"
            export BUNDLE_BIN="$GEM_HOME/bin"
            export PATH="$BUNDLE_BIN:$GEM_HOME/bin:$PATH"
            export JEKYLL_ENV="''${JEKYLL_ENV:-development}"

            echo "blog dev shell — ruby $(ruby -e 'print RUBY_VERSION')"
            echo "  bundle install"
            echo "  bundle exec jekyll serve --livereload   # http://127.0.0.1:4000"
          '';
        };

        # nix run .#serve  /  nix run .#build
        apps = {
          serve = {
            type = "app";
            program = "${pkgs.writeShellScriptBin "serve" ''
              export GEM_HOME="$PWD/.gems"
              export BUNDLE_PATH="$GEM_HOME"
              export PATH="${ruby}/bin:${pkgs.bundler}/bin:$GEM_HOME/bin:$PATH"
              ${pkgs.bundler}/bin/bundle install
              exec ${pkgs.bundler}/bin/bundle exec jekyll serve --livereload "$@"
            ''}/bin/serve";
          };
          build = {
            type = "app";
            program = "${pkgs.writeShellScriptBin "build" ''
              export GEM_HOME="$PWD/.gems"
              export BUNDLE_PATH="$GEM_HOME"
              export JEKYLL_ENV=production
              export PATH="${ruby}/bin:${pkgs.bundler}/bin:$GEM_HOME/bin:$PATH"
              ${pkgs.bundler}/bin/bundle install
              exec ${pkgs.bundler}/bin/bundle exec jekyll build "$@"
            ''}/bin/build";
          };
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}

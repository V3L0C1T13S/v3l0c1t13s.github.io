# My site

I post stuff here.

## If you wanna host it for some reason

With Nix:

```console
nix develop
bundle install
bundle exec jekyll serve --livereload
```

Or without entering the shell:

```console
nix run .#serve      # installs gems and serves on :4000
nix run .#build      # production build into _site/
```

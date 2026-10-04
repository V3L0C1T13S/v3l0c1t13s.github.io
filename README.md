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

Stylesheet URLs include the build timestamp so each deployment gets a fresh
browser/CDN cache entry. GitHub Actions caches installed gems only (and uses
`bundler-cache` to run `bundle install`); it rebuilds the site and checks both
stylesheets before uploading the Pages artifact.

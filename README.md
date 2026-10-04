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

In the repository's **Settings → Pages → Build and deployment**, set **Source**
to **GitHub Actions**. Publishing from `main` also starts GitHub's automatic
Jekyll build, which loads the Primer theme and overwrites `assets/css/style.css`.
The two deployments race, so whichever finishes last determines the live design.

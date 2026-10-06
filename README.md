# Web Themes

Brave extension that restyles bundled sites with the current desktop palette. Site CSS maps onto variables in `colors.css` (`--bg-primary`, `--text-accent`, and the rest). `./setup` rebuilds that file from `~/.themes/current`.

## Install

```bash
./setup
```

That writes `colors.css` and `catalog.json`, then appends this folder to `--load-extension=` in `~/.config/brave-flags.conf` (and Chromium's file if you have one). Fully quit Brave and open it again. An in-app restart keeps the old flags and will not load this.

Run `./setup` again after a theme change, or after adding a package under `sites/<id>/`.

## Site package

```
sites/github/
  site.json
  style.css
```

Your own packages can live in `~/.config/webthemes/sites/<id>/`. They override a bundled package with the same id.

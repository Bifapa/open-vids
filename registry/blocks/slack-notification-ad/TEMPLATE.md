# Slack Notification Ad editing contract

## Surface ownership

This template depicts Slack notifications on an iOS lock screen. Slack and iOS own the notification and device chrome. The supplied website appears in the declared notification copy and the final payoff identity, and nowhere else. The remix is an advertisement for that brand: the payoff notification carries its real name and its own mark.

## Editable slots

Only defaults declared in `data-composition-variables` are editable:

- The eleven request titles and messages
- The final payoff title, message, and logo

Keep replacement copy within 20% of the original length. The payoff logo must remain legible in the existing icon tile.

## Safe editing mechanics

Edit a slot by changing only the `"default"` value of its declaration in the `data-composition-variables` attribute on the `<html>` element of `compositions/slack-notification-ad.html`, with a targeted `edit` replace of that one value, and make every change for one request before checking the result. The JSON sits inside a single-quoted HTML attribute: write an apostrophe in a value as `&#39;`, an ampersand as `&amp;` and a double quote as `\"`. Never rewrite, re-serialise or reformat the attribute or the file, never add, remove or rename a declaration, and never edit a copy of the composition. For the payoff logo, set the default to the path of an image already in the project, such as `assets/logo.svg`; never a remote URL. Afterwards call `inspect_project` to confirm the composition still loads.

## Protected

Preserve the Slack mark on request notifications, iOS status/date/clock labels, wallpaper, notification chrome, fonts, palette, stacking geometry, scene structure, duration, timing, easing, and arrival cadence.

Website colors and typography must never be applied to the Slack or iOS shell.

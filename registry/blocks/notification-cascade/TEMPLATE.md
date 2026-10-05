# Notification Cascade editing contract

## Surface ownership

This is a generic notification presentation with a HyperFrames-branded payoff. The notification geometry, backdrop, stacking behavior, typography, and motion belong to the template. The supplied website is the subject brand placed into declared slots. The remix is an advertisement for that brand, so its real name, its real domain, and its own mark belong in the declared identity slots.

## Editable slots

Only defaults declared in `data-composition-variables` are editable:

- `notifTitle`, `message1` through `message4`, and `appName`
- `headlineTop`, `headlineAccent`, and `footerText`
- `brandLogo`, using a transparent mark that remains legible on the dark closing card

Keep replacement copy within 20% of the original length.

## Safe editing mechanics

Edit a slot by changing only the `"default"` value of its declaration in the `data-composition-variables` attribute on the `<html>` element of `compositions/notification-cascade.html`, with a targeted `edit` replace of that one value, and make every change for one request before checking the result. The JSON sits inside a single-quoted HTML attribute: write an apostrophe in a value as `&#39;`, an ampersand as `&amp;` and a double quote as `\"`. Never rewrite, re-serialise or reformat the attribute or the file, never add, remove or rename a declaration, and never edit a copy of the composition. For an image slot, set the default to the path of an image already in the project, such as `assets/logo.svg`; never a remote URL. Afterwards call `inspect_project` to confirm the composition still loads.

## Protected

Do not change CSS, layout, backdrop, notification chrome, scene structure, duration, timing, easing, stacking, or reveal behavior. Do not replace any image outside the declared closing-card logo slot. Colors are protected because this template declares no color variables.

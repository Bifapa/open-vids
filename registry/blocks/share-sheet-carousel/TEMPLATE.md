# Share-Sheet Carousel editing contract

## Surface ownership

This template depicts an operating-system share sheet. The supplied website is the item or sender shown inside that interface; it does not own the surrounding system UI. The remix is an advertisement for that brand: the sender name, the brand strip, and the wordmark carry its real identity.

## Editable slots

Only defaults declared in `data-composition-variables` are editable:

- `shareTitle`, `senderName`, `itemLabel`, and `stripText`
- `acceptLabel` and `declineLabel`
- `slideImage1` through `slideImage4`; each image also drives its matching blurred background
- `brandLogo`, using a transparent horizontal wordmark

Keep replacement copy within 20% of the original length.

## Safe editing mechanics

Edit a slot by changing only the `"default"` value of its declaration in the `data-composition-variables` attribute on the `<html>` element of `compositions/share-sheet-carousel.html`, with a targeted `edit` replace of that one value, and make every change for one request before checking the result. The JSON sits inside a single-quoted HTML attribute: write an apostrophe in a value as `&#39;`, an ampersand as `&amp;` and a double quote as `\"`. Never rewrite, re-serialise or reformat the attribute or the file, never add, remove or rename a declaration, and never edit a copy of the composition. For an image slot, set the default to the path of an image already in the project, such as `assets/logo.svg`; never a remote URL. Afterwards call `inspect_project` to confirm the composition still loads.

## Protected

Preserve the share-sheet palette, typography, buttons, geometry, carousel layout, scene structure, duration, timing, easing, and tap animation. Do not replace any image outside the declared slide and logo slots, and do not recolor the operating-system interface.

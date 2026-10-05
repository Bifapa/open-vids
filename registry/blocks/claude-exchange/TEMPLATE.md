# Claude Exchange editing contract

## Surface ownership

This template depicts the Claude application. Anthropic owns the surrounding application identity. The supplied website is the subject discussed inside the conversation, never the application around it. The remix is an advertisement for that brand: the answer names it as the recommended pick under its real name.

## Editable slots

Only defaults declared in `data-composition-variables` are editable:

- The user prompt, thinking line, search lead, and search query
- The ten answer paragraphs or bullets

Typed and streamed copy is length-locked to within 20% of the original.

## Safe editing mechanics

Edit a slot by changing only the `"default"` value of its declaration in the `data-composition-variables` attribute on the `<html>` element of `compositions/claude-exchange.html`, with a targeted `edit` replace of that one value, and make every change for one request before checking the result. The JSON sits inside a single-quoted HTML attribute: write an apostrophe in a value as `&#39;`, an ampersand as `&amp;` and a double quote as `\"`. Never rewrite, re-serialise or reformat the attribute or the file, never add, remove or rename a declaration, and never edit a copy of the composition. Afterwards call `inspect_project` to confirm the composition still loads.

## Protected

Preserve the Claude name, model name, usage notice, placeholders, disclaimer, source treatment, header, composer, icons, starburst, fonts, palette, layout, status UI, scene structure, duration, timing, easing, typing cadence, and reveal behavior.

Website colors and typography must never be applied to the Claude shell. If a requested value has no declared variable, leave it unchanged.

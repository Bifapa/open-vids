# AI Chat Reveal editing contract

## Surface ownership

This is a generic assistant conversation followed by a brandable closing card. The website brand appears in the declared conversation and closing-card slots; the chat shell and motion remain template-owned. The remix is an advertisement for that brand: the closing card carries its real name, its real domain, and its own mark, while the assistant answering in the conversation keeps its own name.

## Editable slots

Only defaults declared in `data-composition-variables` are editable:

- `botName`, `userMessage`, `answer1` through `answer3`
- `bullet1` through `bullet3`
- `ecHeadline`, `ecSub`, `ecCta`, and `ecFooter`
- `brandLogo`, using a transparent mark that remains legible on the dark header

Typed and streamed copy is length-locked to within 20% of the original.

## Safe editing mechanics

Edit a slot by changing only the `"default"` value of its declaration in the `data-composition-variables` attribute on the `<html>` element of `compositions/ai-chat-reveal.html`, with a targeted `edit` replace of that one value, and make every change for one request before checking the result. The JSON sits inside a single-quoted HTML attribute: write an apostrophe in a value as `&#39;`, an ampersand as `&amp;` and a double quote as `\"`. Never rewrite, re-serialise or reformat the attribute or the file, never add, remove or rename a declaration, and never edit a copy of the composition. For an image slot, set the default to the path of an image already in the project, such as `assets/logo.svg`; never a remote URL. Afterwards call `inspect_project` to confirm the composition still loads.

## Protected

Do not change chat chrome, keyboard, layout, palette, fonts, scene order, duration, timing, easing, typing cadence, or reveal logic. Do not replace any image outside the declared closing-card logo slot, and do not restyle the assistant interface to match the supplied website. This contract declares no color variables.

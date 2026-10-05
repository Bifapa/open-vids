# Message Thread Reveal editing contract

## Surface ownership

This template depicts a phone messaging interface. The supplied website is the subject of the conversation, shared link, and closing card; it does not own the messaging application chrome. The remix is an advertisement for that brand: the shared link card and the closing card carry its real name and its real domain.

## Editable slots

Only defaults declared in `data-composition-variables` are editable:

- `contactName`
- The complete conversation: `questionMessage`, `teaserMessage`, `reactionMessage`, `reactionEmoji`, `benefitMessage`, `discoveryMessage`, `sourceMessage`, `workflowMessage`, `ownershipMessage`, `installMessage`, and `thanksMessage`
- The shared link: `cardImage`, `cardTitle`, and `cardDomain`
- The closing card: `brandLogo`, `ecProof`, `ecFeature1` through `ecFeature3`, and `ecCta`

Keep replacement copy within 20% of the original length.

## Safe editing mechanics

Edit a slot by changing only the `"default"` value of its declaration in the `data-composition-variables` attribute on the `<html>` element of `compositions/message-thread-reveal.html`, with a targeted `edit` replace of that one value, and make every change for one request before checking the result. The JSON sits inside a single-quoted HTML attribute: write an apostrophe in a value as `&#39;`, an ampersand as `&amp;` and a double quote as `\"`. Never rewrite, re-serialise or reformat the attribute or the file, never add, remove or rename a declaration, and never edit a copy of the composition. For an image slot, set the default to the path of an image already in the project, such as `assets/logo.svg`; never a remote URL. Afterwards call `inspect_project` to confirm the composition still loads.

## Protected

Preserve messaging chrome, bubble styling, receipts, palette, typography, geometry, scene structure, duration, timing, easing, and reveal behavior. Do not replace any image outside the declared link-card and closing-card logo slots, and do not recolor the messaging interface to match the supplied website.

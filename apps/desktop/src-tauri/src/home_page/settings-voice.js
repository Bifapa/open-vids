/* Settings → Voice (beta, only while OV.betaFeatures()): voiceover with the user's own speech provider. The shell only
   reads and writes files (home_voice.rs, the same files and routes Studio's server uses under /api/voice/*): provider
   settings and keys, and the saved voices (presets) with their sample audio. Trying a voice, checking a key and the
   voice catalog live in Studio.
     GET /api/voice/providers → {providers: VoiceProviderInfo[]}   (a key is never part of it: hasKey only)
     PUT /api/voice/providers/:id {model?, baseUrl?, voice?, agentRules?} → {provider}   ("" forgets the setting)
     PUT|DELETE /api/voice/providers/:id/api-key {key} → {provider}
     GET /api/voice/presets → {presets}; PATCH /api/voice/presets/:id {name} → {preset}; DELETE → {ok}
     GET /api/voice/audio/:hash → the sample, fetched with the token and played from a blob
   Provider names, models, addresses, rules and preset names are user- or server-supplied text: always escaped. */
(function () {
  "use strict";
  const { ic, esc, api, ui, PAGES, CLICK, CHANGE, INPUT, ENTER, tr, msg, failMsg, text, group } =
    OVS;
  const { head, lede } = OVS;
  /* Escaped text of a catalog message, for the helpers that take markup. */
  const te = (key, params) => esc(tr(key, params));

  /* Google's terms of the Gemini API: the page the free-tier note points to. */
  const GEMINI_TERMS = "https://ai.google.dev/gemini-api/terms";
  /* packages/agent-protocol VOICE_LIMITS */
  const LIMITS = { model: 200, baseUrl: 2048, voice: 200, agentRules: 4000 };
  /* A cache entry is named by the sha256 of its request; the shell refuses anything else too. */
  const HASH = /^[0-9a-f]{64}$/;

  /* ---------- state ---------- */
  /* providers / presets: null until the first answer. error: why that first read failed. note: the last refusal. */
  const V = { providers: null, presets: null, error: null, note: "" };
  const player = { id: null, el: null, url: null, seq: 0 };

  const provider = (id) => (V.providers || []).find((p) => p.id === id) || null;
  const providerUrl = (id) => "/api/voice/providers/" + encodeURIComponent(id);
  const presetUrl = (id) => "/api/voice/presets/" + encodeURIComponent(id);
  const providerName = (p) => (p.id === "custom" ? tr("settings.voice.provider.custom") : p.name);
  const isPreset = (p) => !!p && typeof p === "object" && typeof p.id === "string";
  const sampleHash = (preset) => {
    const audio = preset.sample && preset.sample.audio;
    return audio && typeof audio.hash === "string" && HASH.test(audio.hash) ? audio.hash : null;
  };

  /* ---------- data ---------- */
  function load() {
    if (ui.flags.voiceLoading) return;
    ui.flags.voiceLoading = true;
    if (!V.providers) V.error = null;
    Promise.all([api("/api/voice/providers"), api("/api/voice/presets")])
      .then(([p, s]) => {
        V.providers = Array.isArray(p && p.providers) ? p.providers : [];
        V.presets = Array.isArray(s && s.presets) ? s.presets.filter(isPreset) : [];
        V.error = null;
      })
      .catch((err) => {
        /* A quiet re-read that fails keeps what is on screen. */
        if (!V.providers) V.error = OV.describeError(err);
      })
      .finally(() => {
        ui.flags.voiceLoading = false;
        OVS.render(true);
      });
  }

  /* The answer of a change carries the provider or the preset it changed. */
  function apply(answer) {
    if (answer && answer.provider && V.providers)
      V.providers = V.providers.map((p) => (p.id === answer.provider.id ? answer.provider : p));
    if (answer && answer.preset && V.presets)
      V.presets = V.presets.map((p) => (p.id === answer.preset.id ? answer.preset : p));
  }
  /* Changes are queued so two quick ones never race. Resolves to the server's refusal (or null when it accepted
     the change); `inline` keeps the refusal at its field instead of in the page note. */
  let queue = Promise.resolve(null);
  function op(request, inline) {
    queue = queue.then(() =>
      request()
        .then((answer) => {
          apply(answer);
          V.note = "";
          return null;
        })
        .catch((err) => {
          if (!inline)
            V.note = failMsg("settings.note.saveFailed", { message: OV.describeError(err) });
          return OV.describeError(err);
        })
        .finally(() => OVS.render(true)),
    );
    return queue;
  }

  /* ---------- playing a saved voice's sample ---------- */
  function stopPlayback() {
    player.seq += 1;
    if (player.el) {
      player.el.pause();
      player.el.removeAttribute("src");
    }
    if (player.url) URL.revokeObjectURL(player.url);
    player.id = player.el = player.url = null;
  }
  /* The route is token-guarded and an <audio src> cannot send the token: fetch the bytes, play them from a blob. */
  function play(id, hash) {
    if (player.id === id) {
      stopPlayback();
      OVS.render(true);
      return;
    }
    stopPlayback();
    const ticket = player.seq;
    player.id = id;
    fetch("/api/voice/audio/" + hash, { headers: { "X-OpenVids-Token": window.OV_TOKEN } })
      .then((res) => {
        if (res.ok) return res.blob();
        return res
          .json()
          .catch(() => ({}))
          .then((body) => {
            throw new Error(
              (body && body.error && body.error.message) ||
                OVI18N.t("home.error.requestFailed", { status: res.status }),
            );
          });
      })
      .then((blob) => {
        if (ticket !== player.seq) return null;
        const url = URL.createObjectURL(blob);
        const el = new Audio(url);
        player.url = url;
        player.el = el;
        el.addEventListener("ended", () => {
          if (player.el !== el) return;
          stopPlayback();
          OVS.render(true);
        });
        return el.play();
      })
      .catch((err) => {
        if (ticket !== player.seq) return;
        stopPlayback();
        V.note = failMsg("settings.voice.preset.playFailed", { message: err.message });
      })
      .finally(() => OVS.render(true));
    OVS.render(true);
  }
  window.addEventListener("pagehide", stopPlayback);

  /* ---------- providers: markup ---------- */
  /* One labelled text field of a provider. Typing is a draft; leaving the field (or Enter) saves it. */
  function field(p, name, label, opts) {
    const k = `vf:${p.id}:${name}`,
      err = ui.err[k],
      id = esc(p.id),
      value = name === "baseUrl" ? p.baseUrl : name === "voice" ? p.voice : p.model;
    return `<label class="st-vfield"><span>${esc(label)}</span><input class="input mono${err ? " is-invalid" : ""}" type="text" autocomplete="off" spellcheck="false" maxlength="${
      LIMITS[name]
    }" value="${esc(value)}" placeholder="${esc(opts.placeholder)}" data-act="voice-field" data-v="${id}" data-field="${name}" data-draft="${esc(
      k,
    )}" data-fk="${esc(k)}"${err ? ` aria-invalid="true" aria-describedby="err-${esc(k)}"` : ""}${
      ui.busy[k] ? " readonly" : ""
    } />${opts.hint ? `<span class="st-vhint">${esc(opts.hint)}</span>` : ""}${
      err
        ? `<span class="st-field-err" id="err-${esc(k)}" role="alert">${esc(text(err))}</span>`
        : ""
    }</label>`;
  }

  /* The key line of a provider: "Key saved" with Replace / Remove once there is one, else the note and the field.
     Drafts, errors and busy flags live under `vkey:<id>`; a key is never drawn into the markup. */
  function keyBlock(p) {
    const id = esc(p.id),
      k = `vkey:${p.id}`,
      busy = !!ui.busy[k],
      err = ui.err[k],
      replacing = p.hasKey && !!ui.flags[`vreplace:${p.id}`],
      name = providerName(p);
    const link = (act, label, aria) =>
      `<button type="button" class="link" data-act="${act}" data-v="${id}" data-fk="${act}:${id}"${
        aria ? ` aria-label="${esc(aria)}"` : ""
      }${busy ? " disabled" : ""}>${label}</button>`;
    const line = p.hasKey
      ? `<span class="status success">${ic("check")}${te("settings.voice.key.saved")}</span>${
          replacing
            ? ""
            : link(
                "vkey-replace",
                te("settings.voice.key.replace"),
                tr("settings.voice.key.replaceAria", { name }),
              ) +
              link(
                "vkey-remove",
                te("common.remove"),
                tr("settings.voice.key.removeAria", { name }),
              )
        }`
      : `${ic("key")}<span>${te(p.keyRequired ? "settings.voice.key.needs" : "settings.voice.key.optional")}</span>`;
    const form =
      !p.hasKey || replacing
        ? `<div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="password" autocomplete="off" spellcheck="false" placeholder="${te(
            "settings.voice.key.placeholder",
          )}" aria-label="${te("settings.voice.key.aria", { name })}" data-act="vkey-input" data-v="${id}" data-draft="${esc(
            k,
          )}" data-fk="vkey-input:${id}"${busy ? " readonly" : ""}${
            err ? ` aria-invalid="true" aria-describedby="err-${esc(k)}"` : ""
          } /><button type="button" class="btn" data-act="vkey-save" data-v="${id}" data-fk="vkey-save:${id}"${
            busy ? ' disabled aria-busy="true"' : ""
          }>${busy ? '<i class="spinner" aria-hidden="true"></i>' : ""}${te("common.save")}</button>${
            replacing
              ? `<button type="button" class="btn btn-ghost" data-act="vkey-cancel" data-v="${id}" data-fk="vkey-cancel:${id}"${
                  busy ? " disabled" : ""
                }>${te("common.cancel")}</button>`
              : ""
          }</div>`
        : "";
    return `<div class="st-vkey"><p class="st-src-key-line">${line}</p>${form}${
      err ? `<p class="st-field-err" id="err-${esc(k)}" role="alert">${esc(text(err))}</p>` : ""
    }</div>`;
  }

  /* What the provider's `notes` say. Unknown notes (a newer server) are not drawn. */
  function notes(p) {
    return (p.notes || [])
      .map((note) => {
        if (note === "free_tier_terms")
          return `<p class="st-foot st-vnote">${OVI18N.rich(
            "settings.voice.note.freeTier",
            {},
            {
              terms: (inner) =>
                `<button type="button" class="link" data-act="voice-terms" data-fk="voice-terms">${inner}</button>`,
            },
          )}</p>`;
        if (note === "catalog_needs_google_key")
          return `<p class="st-foot st-vnote">${te("settings.voice.note.catalogNeedsGoogleKey")}</p>`;
        return "";
      })
      .join("");
  }

  function providerBody(p) {
    const id = esc(p.id),
      rk = `vf:${p.id}:agentRules`,
      rerr = ui.err[rk];
    const fields =
      p.id === "custom"
        ? field(p, "baseUrl", tr("settings.voice.field.baseUrl"), {
            placeholder: "http://127.0.0.1:8880/v1",
            hint: tr("settings.voice.field.baseUrl.hint"),
          }) +
          field(p, "model", tr("settings.voice.field.model"), {
            placeholder: tr("settings.voice.field.model.custom"),
          }) +
          field(p, "voice", tr("settings.voice.field.voice"), {
            placeholder: tr("settings.voice.field.voice.placeholder"),
            hint: tr("settings.voice.field.voice.hint"),
          })
        : field(p, "model", tr("settings.voice.field.model"), {
            placeholder: tr("settings.voice.field.model.placeholder"),
            hint: tr("settings.voice.field.model.hint"),
          });
    const rules = `<label class="st-vfield"><span>${te("settings.voice.field.rules")}</span><textarea class="input st-vrules${
      rerr ? " is-invalid" : ""
    }" rows="3" spellcheck="true" maxlength="${LIMITS.agentRules}" placeholder="${te(
      "settings.voice.field.rules.placeholder",
    )}" data-act="voice-field" data-v="${id}" data-field="agentRules" data-draft="${esc(rk)}" data-fk="${esc(rk)}"${
      rerr ? ` aria-invalid="true" aria-describedby="err-${esc(rk)}"` : ""
    }${ui.busy[rk] ? " readonly" : ""}>${esc(p.agentRules)}</textarea><span class="st-vhint">${te(
      "settings.voice.field.rules.hint",
    )}</span>${
      rerr
        ? `<span class="st-field-err" id="err-${esc(rk)}" role="alert">${esc(text(rerr))}</span>`
        : ""
    }</label>`;
    return `<div class="st-prov-body" data-voice-body="${id}">${fields}${keyBlock(p)}${rules}${notes(p)}<p class="st-foot">${te(
      "settings.voice.key.foot",
    )}</p></div>`;
  }

  function providerRow(p) {
    const id = esc(p.id),
      open = !!ui.open[`voice:${p.id}`],
      name = providerName(p);
    const sub = p.id === "custom" ? p.baseUrl || tr("settings.voice.sub.customEmpty") : p.model;
    const badge = p.configured
      ? `<span class="badge success">${te("settings.voice.badge.ready")}</span>`
      : `<span class="badge warning">${te(
          p.id === "custom" ? "settings.voice.badge.needsSetup" : "settings.voice.badge.needsKey",
        )}</span>`;
    const setUp =
      !p.configured && !open
        ? `<button type="button" class="btn" data-act="voice-open" data-v="${id}" data-fk="vsetup:${id}">${te("settings.providers.setUp")}</button>`
        : "";
    const toggle = `<button type="button" class="icon-btn st-prov-toggle" aria-expanded="${open}" aria-label="${te(
      open ? "settings.voice.hideDetails" : "settings.voice.showDetails",
      { provider: name },
    )}" data-act="voice-toggle" data-v="${id}" data-fk="vtoggle:${id}">${ic("chevron-right")}</button>`;
    return (
      `<div class="st-prov" data-voice-provider="${id}"><span class="dot ${p.configured ? "ok" : "warn"}" aria-hidden="true"></span><div class="st-label"><b>${esc(
        name,
      )}</b><span title="${esc(sub)}">${esc(sub)}</span></div><div class="st-ctl">${badge}${setUp}${toggle}</div></div>` +
      (open ? providerBody(p) : "")
    );
  }

  /* ---------- presets: markup ---------- */
  function presetRow(preset) {
    const id = esc(preset.id),
      name = typeof preset.name === "string" ? preset.name : "",
      rk = `vpreset:${preset.id}`,
      renaming = !!ui.flags[`vrename:${preset.id}`],
      deleting = !!ui.flags[`vdelete:${preset.id}`],
      busy = !!ui.busy[rk],
      err = ui.err[rk],
      hash = sampleHash(preset),
      playing = player.id === preset.id;
    const owner = provider(preset.providerId);
    const voice = preset.voice && typeof preset.voice.name === "string" ? preset.voice.name : "";
    const sub = [owner ? providerName(owner) : preset.providerId, voice]
      .filter(Boolean)
      .join(" · ");
    const playBtn = `<button type="button" class="icon-btn" aria-label="${te(
      playing ? "settings.voice.preset.stopAria" : "settings.voice.preset.playAria",
      { name },
    )}" data-tip="${te(
      hash
        ? playing
          ? "settings.voice.preset.stop"
          : "settings.voice.preset.play"
        : "settings.voice.preset.noSample",
    )}" data-act="vpreset-play" data-v="${id}" data-fk="vplay:${id}"${hash ? "" : " disabled"}>${ic(
      playing ? "pause" : "play",
    )}</button>`;
    let label = `<div class="st-label"><b>${esc(name)}</b><span title="${esc(sub)}">${esc(sub)}</span></div>`;
    let ctl = `<button type="button" class="icon-btn" aria-label="${te(
      "settings.voice.preset.renameAria",
      {
        name,
      },
    )}" data-tip="${te("common.rename")}" data-act="vpreset-rename" data-v="${id}" data-fk="vrename:${id}">${ic(
      "pencil",
    )}</button><button type="button" class="icon-btn" aria-label="${te(
      "settings.voice.preset.deleteAria",
      {
        name,
      },
    )}" data-tip="${te("common.delete")}" data-tip-align="end" data-act="vpreset-delete" data-v="${id}" data-fk="vdelete:${id}">${ic(
      "trash",
    )}</button>`;
    let extra = "";
    if (renaming) {
      label = `<div class="st-label"><input class="input${err ? " is-invalid" : ""}" type="text" autocomplete="off" maxlength="80" value="${esc(
        name,
      )}" aria-label="${te("settings.voice.preset.nameAria")}" data-act="vpreset-name" data-v="${id}" data-draft="${esc(
        rk,
      )}" data-fk="vpreset-name:${id}"${busy ? " readonly" : ""}${
        err ? ` aria-invalid="true" aria-describedby="err-${esc(rk)}"` : ""
      } /></div>`;
      ctl = `<button type="button" class="btn" data-act="vpreset-rename-save" data-v="${id}" data-fk="vpreset-save:${id}"${
        busy ? ' disabled aria-busy="true"' : ""
      }>${busy ? '<i class="spinner" aria-hidden="true"></i>' : ""}${te("common.save")}</button><button type="button" class="btn btn-ghost" data-act="vpreset-rename-cancel" data-v="${id}" data-fk="vpreset-cancel:${id}"${
        busy ? " disabled" : ""
      }>${te("common.cancel")}</button>`;
    } else if (deleting) {
      label = `<div class="st-label"><b>${te("settings.voice.preset.confirmDelete", { name })}</b><span>${te(
        "settings.voice.preset.confirmDelete.hint",
      )}</span></div>`;
      ctl = `<button type="button" class="btn" data-act="vpreset-delete-confirm" data-v="${id}" data-fk="vpreset-confirm:${id}"${
        busy ? ' disabled aria-busy="true"' : ""
      }>${busy ? '<i class="spinner" aria-hidden="true"></i>' : ""}${te("common.delete")}</button><button type="button" class="btn btn-ghost" data-act="vpreset-delete-cancel" data-v="${id}" data-fk="vpreset-nodelete:${id}"${
        busy ? " disabled" : ""
      }>${te("common.cancel")}</button>`;
    }
    if (err)
      extra = `<p class="st-field-err st-vpreset-err" id="err-${esc(rk)}" role="alert">${esc(text(err))}</p>`;
    return `<div class="st-row st-vpreset" data-voice-preset="${id}">${playBtn}${label}<div class="st-ctl">${ctl}</div>${extra}</div>`;
  }

  PAGES.voice = function () {
    const title = tr("settings.section.voice");
    const intro = lede("settings.voice.lede");
    if (!V.providers)
      return (
        head(title) +
        intro +
        (V.error
          ? OVS.failure("settings.voice.failure", V.error, "voice-retry")
          : OVS.loading("settings.voice.loading"))
      );
    const ready = V.providers.filter((p) => p.configured).length;
    const meta = `<span class="note">${te("settings.voice.meta", {
      ready,
      total: V.providers.length,
    })}</span>`;
    const presets = V.presets || [];
    const presetBody = presets.length
      ? presets.map(presetRow).join("")
      : `<div class="st-row"><div class="st-label"><span>${te("settings.voice.presets.empty")}</span></div></div>`;
    return (
      head(title) +
      intro +
      OVS.noteHtml(V.note) +
      `<section class="st-group"><div class="sect-label"><span>${te("settings.voice.group.providers")}</span>${meta}</div><div class="st-box">${V.providers
        .map(providerRow)
        .join("")}</div></section>` +
      group(te("settings.voice.group.presets"), presetBody) +
      `<p class="st-foot">${te("settings.voice.presets.foot")}</p>`
    );
  };

  /* ---------- providers: actions ---------- */
  CLICK["voice-retry"] = () => load();
  CLICK["voice-toggle"] = (t) => {
    const k = `voice:${t.dataset.v}`;
    ui.open[k] = !ui.open[k];
  };
  CLICK["voice-open"] = (t) => {
    ui.open[`voice:${t.dataset.v}`] = true;
    const p = provider(t.dataset.v);
    ui.pendingFk = p && p.id === "custom" ? `vf:${p.id}:baseUrl` : `vkey-input:${t.dataset.v}`;
  };
  /* The terms open in the default browser through the shell, which only opens https addresses. */
  CLICK["voice-terms"] = () => {
    api("/api/open-external", { url: GEMINI_TERMS }).catch(() => {});
    return false;
  };

  /* A setting is saved when the field is left (or Enter): "" forgets it, the server says what the value becomes. */
  function saveField(t) {
    const id = t.dataset.v,
      name = t.dataset.field,
      k = `vf:${id}:${name}`,
      p = provider(id);
    if (!p || ui.busy[k]) return;
    const current = name === "agentRules" ? p.agentRules : p[name];
    const value = t.value.trim();
    delete ui.err[k];
    if (value === current) {
      delete ui.draft[k];
      OVS.render(true);
      return;
    }
    ui.busy[k] = true;
    op(() => api(providerUrl(id), { [name]: value }, "PUT"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      else delete ui.draft[k];
      OVS.render(true);
    });
    OVS.render(true);
  }
  CHANGE["voice-field"] = (t) => saveField(t);
  INPUT["voice-field"] = (t) => {
    const k = `vf:${t.dataset.v}:${t.dataset.field}`;
    ui.draft[k] = t.value;
    if (ui.err[k]) {
      delete ui.err[k];
      OVS.render(true);
    }
  };
  /* Leaving the field is what saves: the change event follows the blur. */
  ENTER["voice-field"] = (t) => t.blur();

  /* ---- the user's own key ---- */
  function saveKey(id) {
    const k = `vkey:${id}`,
      key = (ui.draft[k] || "").trim();
    if (ui.busy[k]) return;
    if (!key) {
      ui.err[k] = msg("settings.key.error.empty");
      return;
    }
    if (/\s/.test(key)) {
      ui.err[k] = msg("settings.key.error.spaces");
      return;
    }
    if (key.length > 4096) {
      ui.err[k] = msg("settings.key.error.tooLong");
      return;
    }
    delete ui.err[k];
    ui.busy[k] = true;
    op(() => api(providerUrl(id) + "/api-key", { key }, "PUT"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      else {
        delete ui.draft[k];
        delete ui.flags[`vreplace:${id}`];
      }
      ui.pendingFk = refusal ? `vkey-input:${id}` : `vkey-replace:${id}`;
      OVS.render(true);
      ui.pendingFk = null;
    });
  }
  CLICK["vkey-save"] = (t) => saveKey(t.dataset.v);
  CLICK["vkey-replace"] = (t) => {
    ui.flags[`vreplace:${t.dataset.v}`] = true;
    ui.pendingFk = `vkey-input:${t.dataset.v}`;
  };
  CLICK["vkey-cancel"] = (t) => {
    const id = t.dataset.v;
    delete ui.flags[`vreplace:${id}`];
    delete ui.draft[`vkey:${id}`];
    delete ui.err[`vkey:${id}`];
    ui.pendingFk = `vkey-replace:${id}`;
  };
  CLICK["vkey-remove"] = (t) => {
    const id = t.dataset.v,
      k = `vkey:${id}`;
    if (ui.busy[k]) return;
    delete ui.err[k];
    ui.busy[k] = true;
    op(() => api(providerUrl(id) + "/api-key", undefined, "DELETE"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      ui.pendingFk = refusal ? `vkey-remove:${id}` : `vkey-input:${id}`;
      OVS.render(true);
      ui.pendingFk = null;
    });
  };
  INPUT["vkey-input"] = (t) => {
    const k = `vkey:${t.dataset.v}`;
    ui.draft[k] = t.value;
    if (ui.err[k]) {
      delete ui.err[k];
      OVS.render(true);
    }
  };
  ENTER["vkey-input"] = (t) => {
    saveKey(t.dataset.v);
    OVS.render(true);
  };

  /* ---------- presets: actions ---------- */
  function endEdit(id) {
    delete ui.flags[`vrename:${id}`];
    delete ui.flags[`vdelete:${id}`];
    delete ui.draft[`vpreset:${id}`];
    delete ui.err[`vpreset:${id}`];
  }
  CLICK["vpreset-play"] = (t) => {
    const preset = (V.presets || []).find((p) => p.id === t.dataset.v),
      hash = preset && sampleHash(preset);
    if (hash) play(preset.id, hash);
    return false;
  };
  CLICK["vpreset-rename"] = (t) => {
    const id = t.dataset.v,
      preset = (V.presets || []).find((p) => p.id === id);
    endEdit(id);
    ui.flags[`vrename:${id}`] = true;
    if (preset) ui.draft[`vpreset:${id}`] = preset.name;
    ui.pendingFk = `vpreset-name:${id}`;
  };
  function saveName(id) {
    const k = `vpreset:${id}`,
      name = (ui.draft[k] || "").trim();
    if (ui.busy[k]) return;
    const preset = (V.presets || []).find((p) => p.id === id);
    if (!preset) return;
    if (!name) {
      ui.err[k] = msg("settings.voice.preset.error.nameEmpty");
      return;
    }
    if (name === preset.name) {
      endEdit(id);
      ui.pendingFk = `vrename:${id}`;
      return;
    }
    delete ui.err[k];
    ui.busy[k] = true;
    op(() => api(presetUrl(id), { name }, "PATCH"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      else endEdit(id);
      ui.pendingFk = refusal ? `vpreset-name:${id}` : `vrename:${id}`;
      OVS.render(true);
      ui.pendingFk = null;
    });
  }
  CLICK["vpreset-rename-save"] = (t) => saveName(t.dataset.v);
  CLICK["vpreset-rename-cancel"] = (t) => {
    endEdit(t.dataset.v);
    ui.pendingFk = `vrename:${t.dataset.v}`;
  };
  INPUT["vpreset-name"] = (t) => {
    const k = `vpreset:${t.dataset.v}`;
    ui.draft[k] = t.value;
    if (ui.err[k]) {
      delete ui.err[k];
      OVS.render(true);
    }
  };
  ENTER["vpreset-name"] = (t) => {
    saveName(t.dataset.v);
    OVS.render(true);
  };
  CLICK["vpreset-delete"] = (t) => {
    const id = t.dataset.v;
    endEdit(id);
    ui.flags[`vdelete:${id}`] = true;
    ui.pendingFk = `vpreset-nodelete:${id}`;
  };
  CLICK["vpreset-delete-cancel"] = (t) => {
    endEdit(t.dataset.v);
    ui.pendingFk = `vdelete:${t.dataset.v}`;
  };
  CLICK["vpreset-delete-confirm"] = (t) => {
    const id = t.dataset.v,
      k = `vpreset:${id}`;
    if (ui.busy[k]) return;
    delete ui.err[k];
    ui.busy[k] = true;
    if (player.id === id) stopPlayback();
    op(() => api(presetUrl(id), undefined, "DELETE"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      else {
        V.presets = (V.presets || []).filter((p) => p.id !== id);
        endEdit(id);
      }
      ui.pendingFk = refusal ? `vpreset-confirm:${id}` : null;
      OVS.render(true);
      ui.pendingFk = null;
    });
  };

  /* Entering the section reads the files again (Studio may have saved a voice or a key meanwhile); leaving it
     stops a sample that is playing. */
  OVS.ON_ENTER.voice = () => load();
  OVS.ON_LEAVE.voice = () => {
    stopPlayback();
  };
})();

import {
  CheckCircle,
  Clock,
  DownloadSimple,
  FilmSlate,
  Globe,
  Scales,
  ShieldWarning,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type {
  PermissionAction,
  PermissionKind,
  PermissionState,
} from "@hyperframes/agent-protocol";
import type { TranslationKey } from "../../i18n";
import type { ButtonVariant } from "../ui";

export type AnsweredState = Exclude<PermissionState, "pending">;

/** One answer button: its label, the tooltip that says what it does, and how loud it is. */
export interface AnswerView {
  label: TranslationKey;
  hint: TranslationKey;
  variant: ButtonVariant;
  /** The tooltip when the request names a site (`{site}`): the answer covers that site only. */
  siteHint?: TranslationKey;
}

/** The setting a request is about, as Settings words it: the same name and hint, never a second copy. */
export interface SettingView {
  name: TranslationKey;
  hint: TranslationKey;
  section: TranslationKey;
  group: TranslationKey;
}

/** What a kind of request puts under its sentence. */
export type PermissionDetail =
  /** The setting it is about, with where to find it. */
  | { type: "setting"; setting: SettingView }
  /** A plain explanation (no setting is involved: the answer applies to this one request). */
  | { type: "note"; text: TranslationKey };

/** Everything about a kind of request that is wording or look; the card itself is the same for all of them. */
export interface KindView {
  icon: Icon;
  /** The heading while it asks. */
  title: TranslationKey;
  /** The heading once answered: "… is off" / "… needs your OK" would contradict the status line under it. */
  settledTitle: TranslationKey;
  detail: PermissionDetail;
  once: AnswerView;
  /** The answer that changes a setting for good; null when the request has no setting (one-off consent). */
  always: AnswerView | null;
  /** The label of the refusing button. */
  deny: TranslationKey;
  states: Record<AnsweredState, TranslationKey>;
  /** The material the request is about is shown (with its license). */
  showsAsset: boolean;
}

export const WEBSITE_STATES: Record<AnsweredState, TranslationKey> = {
  allowed_once: "chat.permission.state.allowed_once",
  enabled: "chat.permission.state.enabled",
  denied: "chat.permission.state.denied",
  expired: "chat.permission.state.expired",
};

/** The two Asset Search → Websites settings turn on for good ("Turn on"); "Allow once" lasts the turn. */
const WEBSITE_ANSWERS = {
  once: {
    label: "chat.permission.once",
    hint: "chat.permission.onceHint",
    siteHint: "chat.permission.onceHintSite",
    variant: "secondary",
  },
  always: {
    label: "chat.permission.always",
    hint: "chat.permission.alwaysHint",
    variant: "primary",
  },
  deny: "chat.permission.deny",
} as const satisfies Pick<KindView, "once" | "always" | "deny">;

const WEBSITE_GROUP: Pick<SettingView, "section" | "group"> = {
  section: "settings.section.assets",
  group: "research.policy.groupWebsites",
};

export const KIND_VIEWS: Record<PermissionKind, KindView> = {
  read_linked_pages: {
    icon: Globe,
    title: "chat.permission.title.read_linked_pages",
    settledTitle: "research.policy.readLinked",
    detail: {
      type: "setting",
      setting: {
        name: "research.policy.readLinked",
        hint: "research.policy.readLinked.hint",
        ...WEBSITE_GROUP,
      },
    },
    ...WEBSITE_ANSWERS,
    states: WEBSITE_STATES,
    showsAsset: false,
  },
  website_full_access: {
    icon: ShieldWarning,
    title: "chat.permission.title.website_full_access",
    settledTitle: "research.policy.fullAccess",
    detail: {
      type: "setting",
      setting: {
        name: "research.policy.fullAccess",
        hint: "research.policy.fullAccess.hint",
        ...WEBSITE_GROUP,
      },
    },
    ...WEBSITE_ANSWERS,
    states: WEBSITE_STATES,
    showsAsset: false,
  },
  // Downloading is the agents' Autonomy rule, not an Asset Search one. The loud answer is the one that only lasts
  // the turn: "Don't ask again" changes every project.
  asset_download: {
    icon: DownloadSimple,
    title: "chat.permission.title.asset_download",
    settledTitle: "chat.permission.title.asset_download.settled",
    detail: {
      type: "setting",
      setting: {
        name: "settings.execution.askDownloads",
        hint: "settings.execution.askDownloads.hintOn",
        section: "settings.section.execution",
        group: "settings.execution.group.autonomy",
      },
    },
    once: {
      label: "chat.permission.assetOnce",
      hint: "chat.permission.assetOnceHint",
      variant: "primary",
    },
    always: {
      label: "chat.permission.assetAlways",
      hint: "chat.permission.assetAlwaysHint",
      variant: "secondary",
    },
    deny: "chat.permission.deny",
    states: {
      ...WEBSITE_STATES,
      allowed_once: "chat.permission.state.allowed_once.asset_download",
      enabled: "chat.permission.state.enabled.asset_download",
    },
    showsAsset: true,
  },
  // A render that would run for minutes and that the user did not clearly ask for. One-off consent: there is no
  // setting to turn on, so the only answers are this render or none.
  long_render: {
    icon: FilmSlate,
    title: "chat.permission.title.long_render",
    settledTitle: "chat.permission.title.long_render.settled",
    detail: { type: "note", text: "chat.permission.longRender.note" },
    once: {
      label: "chat.permission.renderOnce",
      hint: "chat.permission.renderOnceHint",
      variant: "primary",
    },
    always: null,
    deny: "chat.permission.renderDeny",
    states: {
      ...WEBSITE_STATES,
      allowed_once: "chat.permission.state.allowed_once.long_render",
      enabled: "chat.permission.state.allowed_once.long_render",
      denied: "chat.permission.state.denied.long_render",
    },
    showsAsset: false,
  },
  // Material whose license is restricted: asked per file, even when downloads were approved for the turn.
  restricted_asset: {
    icon: Scales,
    title: "chat.permission.title.restricted_asset",
    settledTitle: "chat.permission.title.restricted_asset.settled",
    detail: { type: "note", text: "chat.permission.restrictedAsset.note" },
    once: {
      label: "chat.permission.restrictedOnce",
      hint: "chat.permission.restrictedOnceHint",
      variant: "secondary",
    },
    always: null,
    deny: "chat.permission.restrictedDeny",
    states: {
      ...WEBSITE_STATES,
      allowed_once: "chat.permission.state.allowed_once.restricted_asset",
      enabled: "chat.permission.state.allowed_once.restricted_asset",
      denied: "chat.permission.state.denied.restricted_asset",
    },
    showsAsset: true,
  },
};

/** What the agent was about to do with a website; the sentence names the site when the request has one. */
export const SENTENCE_KEYS = {
  read: "chat.permission.read",
  download: "chat.permission.download",
  read_code: "chat.permission.read_code",
  record: "chat.permission.record",
} as const satisfies Partial<Record<PermissionAction, TranslationKey>>;

export const STATE_ICONS: Record<AnsweredState, Icon> = {
  allowed_once: CheckCircle,
  enabled: CheckCircle,
  denied: XCircle,
  expired: Clock,
};

export const STATE_TONES: Record<AnsweredState, string> = {
  allowed_once: "text-success",
  enabled: "text-success",
  denied: "text-fg-2",
  expired: "text-fg-3",
};

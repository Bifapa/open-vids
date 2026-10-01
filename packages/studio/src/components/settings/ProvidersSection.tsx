import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CaretDown } from "@phosphor-icons/react";
import { useAgentStore, useAgentStoreApi } from "../../agent/agentContext";
import { formatNumber, useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Status";
import { ProviderRow } from "./ProviderRow";
import { signInFlows } from "./ProviderSignIn";
import { modelUsers, splitProviders, syncedLabel } from "./providerStatus";
import { SettingsGroup, SettingsPage, SettingsUnavailable } from "./settingsLayout";
import { useSettingsDialog } from "./settingsStore";
import { useOAuthSignIns } from "./useOAuthSignIns";

type Busy = { provider: string; label: string };

/** Re-renders now and then so "Synced 2 min ago" stays true while the section is open. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Models & Providers: every provider the agent runtime knows, where its credential stands, which models agents and
 * Jev run on it, and the one thing OpenVids can do about it from here: keep an API key of its own for a provider.
 * Sign-in with an account is done in OMP, which OpenVids only reads.
 */
export function ProvidersSection() {
  const { t } = useTranslation();
  const store = useAgentStoreApi();
  const providers = useAgentStore((state) => state.providers);
  const syncedAt = useAgentStore((state) => state.providersSyncedAt);
  const settings = useAgentStore((state) => state.settings);
  const catalog = useAgentStore((state) => state.models);
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const reloadProviders = useAgentStore((state) => state.reloadProviders);
  const refreshProviders = useAgentStore((state) => state.refreshProviders);
  const setProviderApiKey = useAgentStore((state) => state.setProviderApiKey);
  const signOutProvider = useAgentStore((state) => state.signOutProvider);
  const startOAuthLogin = useAgentStore((state) => state.startOAuthLogin);
  const pollOAuthLogin = useAgentStore((state) => state.pollOAuthLogin);
  const submitOAuthInput = useAgentStore((state) => state.submitOAuthInput);
  const cancelOAuthLogin = useAgentStore((state) => state.cancelOAuthLogin);
  const reloadAfterSignIn = useAgentStore((state) => state.reloadAfterSignIn);
  const providerToOpen = useSettingsDialog((state) => state.providerToOpen);
  const clearProviderToOpen = useSettingsDialog((state) => state.clearProviderToOpen);
  const now = useNow(30_000);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const signIns = useOAuthSignIns({
    start: startOAuthLogin,
    poll: pollOAuthLogin,
    submit: submitOAuthInput,
    cancel: cancelOAuthLogin,
    onSucceeded: (provider) => {
      // As after saving a key: the list and the model catalog as the runtime has them now.
      setOpen((current) => new Set(current).add(provider));
      void reloadAfterSignIn();
    },
  });

  // The first look loads the list; every later look re-reads it quietly, so a sign-in done in OMP shows up.
  useEffect(() => {
    if (store.getState().providers?.status === "ready") void reloadProviders();
    else void loadProviders();
  }, [store, loadProviders, reloadProviders]);

  const list = providers?.status === "ready" ? providers.value : null;
  const { shown, rest } = useMemo(() => splitProviders(list ?? []), [list]);
  const users = useMemo(() => modelUsers(settings, catalog), [settings, catalog]);

  // A "Fix" link elsewhere asked for one provider's details: open it, even behind the disclosure, and bring it into view.
  useEffect(() => {
    if (!providerToOpen || !list) return;
    const known = list.some((provider) => provider.id === providerToOpen);
    if (known) {
      setOpen((current) => new Set(current).add(providerToOpen));
      if (rest.some((provider) => provider.id === providerToOpen)) setShowAll(true);
    }
    clearProviderToOpen();
    window.requestAnimationFrame(() => {
      const rows = pageRef.current?.querySelectorAll("[data-provider]") ?? [];
      [...rows]
        .find((element) => element.getAttribute("data-provider") === providerToOpen)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, [providerToOpen, list, rest, clearProviderToOpen]);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const run = async (
    provider: string | null,
    label: string,
    action: () => Promise<{ ok: true } | { ok: false; message: string }>,
  ): Promise<string | null> => {
    setProblem(null);
    if (provider) setBusy({ provider, label });
    else setSyncing(true);
    const result = await action();
    setBusy(null);
    setSyncing(false);
    return result.ok ? null : result.message;
  };

  const refresh = async (provider: string | null, label: string) => {
    const failure = await run(provider, label, refreshProviders);
    if (failure) setProblem(failure);
  };

  if (!list) {
    return (
      <SettingsPage title={t("settings.section.providers")}>
        <SettingsUnavailable
          message={
            providers?.status === "failed" ? providers.message : t("settings.loading.providers")
          }
          action={
            providers?.status === "failed" ? (
              <Button size="sm" onClick={() => void loadProviders()}>
                {t("common.tryAgain")}
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const connected = list.filter((provider) => provider.status === "connected").length;
  const row = (provider: (typeof list)[number]) => (
    <ProviderRow
      key={provider.id}
      provider={provider}
      open={open.has(provider.id)}
      onToggle={() => toggle(provider.id)}
      busy={busy?.provider === provider.id ? busy.label : null}
      models={catalog ? catalog.models.filter((model) => model.provider === provider.id) : null}
      users={users}
      onSaveKey={async (apiKey) => {
        const failure = await run(provider.id, t("settings.studio.pv.connecting"), () =>
          setProviderApiKey(provider.id, apiKey),
        );
        if (failure === null) setOpen((current) => new Set(current).add(provider.id));
        return failure;
      }}
      onRemoveKey={() => {
        void run(provider.id, t("settings.jev.busy.removing"), () =>
          setProviderApiKey(provider.id, null),
        ).then((failure) => {
          if (failure) setProblem(failure);
          else setOpen((current) => new Set([...current].filter((id) => id !== provider.id)));
        });
      }}
      onRetry={() => void refresh(provider.id, t("settings.providers.busy.checking"))}
      onRefresh={() => void refresh(null, "")}
      signIn={
        signInFlows(provider).length === 0
          ? null
          : {
              view: signIns.viewOf(provider.id),
              start: (flow) => {
                setOpen((current) => new Set(current).add(provider.id));
                void signIns.start(provider.id, flow);
              },
              submit: (text) => signIns.submit(provider.id, text),
              cancel: () => void signIns.cancel(provider.id),
            }
      }
      onSignOut={() => {
        void run(provider.id, t("settings.providers.busy.signingOut"), () =>
          signOutProvider(provider.id),
        ).then((failure) => failure && setProblem(failure));
      }}
    />
  );

  const meta = (
    <>
      {syncing ? (
        <>
          <Spinner />
          {t("settings.providers.syncing")}
        </>
      ) : (
        <span>
          {syncedAt === null ? t("settings.providers.notSynced") : syncedLabel(syncedAt, now)}
        </span>
      )}
      <Button
        disabled={syncing || busy !== null}
        icon={<ArrowsClockwise aria-hidden className="size-icon-md" />}
        onClick={() => void refresh(null, "")}
      >
        {t("settings.providers.refresh")}
      </Button>
    </>
  );

  return (
    <div ref={pageRef}>
      <SettingsPage
        title={t("settings.section.providers")}
        meta={meta}
        lede={t("settings.studio.pv.lede")}
      >
        <SettingsGroup
          label={t("settings.providers.group.providers")}
          note={t("settings.providers.connectedCount", {
            connected: formatNumber(connected),
            total: formatNumber(list.length),
          })}
          footer={
            problem ? (
              <span role="alert" className="text-error">
                {problem}
              </span>
            ) : undefined
          }
        >
          {shown.map(row)}
          {rest.length > 0 && (
            <>
              {showAll && rest.map(row)}
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll((current) => !current)}
                className="flex h-ctl w-full items-center gap-1.5 px-3 text-left text-sm text-fg-2 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <CaretDown
                  aria-hidden
                  className={`size-icon-sm text-fg-3 transition-transform duration-hover ${showAll ? "rotate-180" : ""}`}
                />
                {showAll ? t("settings.studio.pv.showFewer") : t("settings.studio.pv.showAll")}
                {!showAll && (
                  <span className="text-xs text-fg-3">
                    {t("settings.studio.pv.more", { count: formatNumber(rest.length) })}
                  </span>
                )}
              </button>
            </>
          )}
        </SettingsGroup>
      </SettingsPage>
    </div>
  );
}

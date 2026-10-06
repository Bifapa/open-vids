import { Plus, Palette, X } from "@phosphor-icons/react";
import { Button, IconButton, Spinner } from "../components/ui";
import { useTranslation } from "../i18n";
import { useDesignStore, useDesignStoreApi } from "./designContext";
import { DesignCurrent } from "./DesignCurrent";
import { DesignLibraryList } from "./DesignLibraryList";
import { useDesignUi } from "./designUiStore";

/**
 * The popover's content: the project's current system, the library to pick from, and the ways to make a new system.
 * Every change is an explicit click; attaching copies files into the project and edits no composition. Starting
 * the agent (create, edit) and the preview open a dialog, so the popover hands over and closes through `onDone`.
 */
export function DesignPanel({ projectId, onDone }: { projectId: string; onDone(): void }) {
  const { t } = useTranslation();
  const store = useDesignStoreApi();
  const library = useDesignStore((state) => state.library);
  const project = useDesignStore((state) => state.project);
  const mutation = useDesignStore((state) => state.mutation);
  const notice = useDesignStore((state) => state.notice);
  const ui = useDesignUi.getState();

  const state = project.state;
  const attached = state?.attached ?? null;
  const error = project.error ?? library.error;
  const handOver = (open: () => void) => {
    open();
    onDone();
  };

  return (
    <div data-testid="design-panel" className="flex w-full flex-col gap-2.5">
      <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-fg">
        <Palette size={14} aria-hidden className="text-fg-3" />
        {t("studio.design.title")}
      </h2>

      {notice ? (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md bg-error-soft px-2 py-1.5 text-xs text-error"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span>{notice.message}</span>
            {notice.issues.slice(0, 3).map((issue) => (
              <span key={issue} className="truncate text-fg-2" title={issue}>
                {issue}
              </span>
            ))}
          </div>
          <IconButton
            size="xs"
            aria-label={t("common.close")}
            icon={<X size={10} aria-hidden />}
            onClick={() => store.getState().dismissNotice()}
          />
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          data-testid="design-error"
          className="flex items-center justify-between gap-2 text-xs text-error"
        >
          <span>{error}</span>
          <Button size="xs" variant="secondary" onClick={() => void store.getState().refresh()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : null}

      <div className="flex max-h-[min(440px,calc(100vh-220px))] min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain">
        {state === null && project.status === "loading" ? (
          <p className="m-0 flex items-center gap-1.5 text-xs text-fg-3">
            <Spinner />
            {t("studio.design.loading")}
          </p>
        ) : null}

        {state !== null && attached === null ? (
          <div className="flex flex-col gap-0.5">
            <p className="m-0 text-sm font-medium text-fg">{t("studio.design.none.title")}</p>
            <p className="m-0 text-xs text-fg-3">{t("studio.design.none.hint")}</p>
          </div>
        ) : null}

        {state !== null && attached !== null ? (
          <DesignCurrent
            state={state}
            facts={project.facts}
            mutation={mutation}
            onPreview={() =>
              handOver(() => ui.openPreview({ kind: "project", projectId }, attached.name))
            }
            onDetach={() => void store.getState().detach()}
            onUpdate={() => void store.getState().update()}
          />
        ) : null}

        <section className="flex flex-col gap-1">
          {library.systems.length > 0 || library.status !== "error" ? (
            <h3 className="m-0 text-xs font-semibold text-fg-2">
              {t("studio.design.library.title")}
            </h3>
          ) : null}
          {library.systems.length > 0 ? (
            <>
              <DesignLibraryList
                systems={library.systems}
                attachedId={attached?.id ?? null}
                mutation={mutation}
                onAttach={(id) => void store.getState().attach(id)}
                onPreview={(system) =>
                  handOver(() =>
                    ui.openPreview(
                      { kind: "library", id: system.id, version: system.version },
                      system.name,
                    ),
                  )
                }
                onEdit={(system) => handOver(() => ui.openEdit(system.id))}
              />
              <p className="m-0 text-2xs leading-[13px] text-fg-3">
                {t("studio.design.library.attachNote")}
              </p>
            </>
          ) : library.status === "ready" ? (
            <p className="m-0 text-xs text-fg-3">{t("studio.design.library.empty")}</p>
          ) : library.status === "loading" ? (
            <p className="m-0 flex items-center gap-1.5 text-xs text-fg-3">
              <Spinner />
              {t("studio.design.library.loading")}
            </p>
          ) : null}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-2.5">
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={12} aria-hidden />}
          onClick={() => handOver(() => ui.openCreate("scratch"))}
        >
          {t("studio.design.create.open")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => handOver(() => ui.openCreate("project"))}>
          {t("studio.design.create.fromProject")}
        </Button>
      </div>
    </div>
  );
}

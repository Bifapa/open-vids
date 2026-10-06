import { useState } from "react";
import type { UsageSlice } from "@hyperframes/agent-protocol";
import { formatCost, formatTokens } from "../../agent/usageFormat";
import { formatPercent, useTranslation } from "../../i18n";
import { Badge, Button, Meter, SegmentedControl, Spinner } from "../ui";
import { USAGE_PERIODS, type UsagePeriod } from "./usagePeriod";
import { tokenShare, USAGE_VIEWS, usageRows, type UsageRow, type UsageView } from "./usageRows";
import type { ProjectUsage } from "./useProjectUsage";

interface UsagePanelProps {
  usage: ProjectUsage;
  period: UsagePeriod;
  onPeriodChange: (period: UsagePeriod) => void;
}

/** A cost, or the honest "tokens only" when the providers reported none: never a zero. */
function CostText({ slice }: { slice: UsageSlice }) {
  const { t } = useTranslation();
  return slice.usage.cost === null ? (
    <span className="text-fg-3">{t("shell.usage.tokensOnly")}</span>
  ) : (
    <span>
      {slice.unpricedTokens > 0 ? "≥ " : ""}
      {formatCost(slice.usage.cost)}
    </span>
  );
}

function Total({ slice, live }: { slice: UsageSlice; live: boolean }) {
  const { t } = useTranslation();
  const incomplete = slice.usage.cost !== null && slice.unpricedTokens > 0;
  return (
    <section
      data-testid="usage-total"
      aria-label={t("shell.usage.total")}
      className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-fg-2">
        <span>{t("shell.usage.total")}</span>
        {live ? (
          <span className="inline-flex items-center gap-1 text-fg-3" title={t("shell.usage.live")}>
            <Spinner />
            <span className="sr-only">{t("shell.usage.live")}</span>
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xl font-semibold text-fg tabular-nums" data-testid="usage-total-cost">
          <CostText slice={slice} />
        </span>
        <span className="text-xs text-fg-2 tabular-nums">
          {t("chat.usage.summary", { tokens: formatTokens(slice.usage.totalTokens) })}
        </span>
      </div>
      {incomplete ? (
        <p
          className="m-0 flex items-start gap-1.5 text-xs text-fg-3"
          data-testid="usage-incomplete"
        >
          <Badge tone="warning" size="sm">
            {t("shell.usage.incomplete")}
          </Badge>
          <span>
            {t("shell.usage.incompleteNote", { tokens: formatTokens(slice.unpricedTokens) })}
          </span>
        </p>
      ) : slice.usage.cost === null && slice.usage.totalTokens > 0 ? (
        <p className="m-0 text-xs text-fg-3">{t("shell.usage.tokensOnlyNote")}</p>
      ) : null}
    </section>
  );
}

function Row({ row, total }: { row: UsageRow; total: UsageSlice }) {
  const { t } = useTranslation();
  const share = tokenShare(row.slice, total);
  return (
    <li data-testid="usage-row" className="flex flex-col gap-1 py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-fg" title={row.hint ?? row.label}>
          {row.label}
        </span>
        <span className="shrink-0 text-fg tabular-nums">
          <CostText slice={row.slice} />
        </span>
      </div>
      <Meter
        value={share}
        label={t("shell.usage.share", { percent: formatPercent(share) })}
        size="md"
      />
      <div className="flex justify-between text-2xs text-fg-3 tabular-nums">
        <span>
          {t("chat.usage.summary", { tokens: formatTokens(row.slice.usage.totalTokens) })}
        </span>
        <span>{formatPercent(share)}</span>
      </div>
    </li>
  );
}

/** The popover's content: the project's total, a period and a slice switch, and the rows (scrolling inside). */
export function UsagePanel({ usage, period, onPeriodChange }: UsagePanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<UsageView>("agents");
  const { report, status, reload } = usage;

  const periodOptions = USAGE_PERIODS.map((value) => ({
    value,
    label: t(`shell.usage.period.${value}`),
  }));
  const viewOptions = USAGE_VIEWS.map((value) => ({
    value,
    label: t(`shell.usage.view.${value}`),
  }));

  const rows = report ? usageRows(report, view) : [];
  const own = rows.filter((row) => !row.internal);
  const internal = rows.filter((row) => row.internal);
  const empty = report !== null && report.total.usage.totalTokens === 0;

  return (
    <div className="flex w-full flex-col gap-2.5" data-testid="usage-panel">
      <h2 className="m-0 text-sm font-semibold text-fg">{t("shell.usage.title")}</h2>
      <SegmentedControl
        label={t("shell.usage.period.label")}
        value={period}
        options={periodOptions}
        onChange={onPeriodChange}
        size="sm"
      />
      {report ? <Total slice={report.total} live={report.live} /> : null}
      {status === "error" ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-error">
          <span>{t("shell.usage.error")}</span>
          <Button size="xs" variant="secondary" onClick={reload}>
            {t("shell.usage.retry")}
          </Button>
        </div>
      ) : null}
      {report === null && status !== "error" ? (
        <p className="m-0 text-xs text-fg-3">{t("shell.usage.loading")}</p>
      ) : null}
      {empty ? <p className="m-0 text-xs text-fg-3">{t("shell.usage.empty")}</p> : null}
      {report && !empty ? (
        <>
          <SegmentedControl
            label={t("shell.usage.view.label")}
            value={view}
            options={viewOptions}
            onChange={setView}
            size="sm"
          />
          <div
            data-testid="usage-rows"
            className="-mx-1 max-h-[min(40vh,280px)] overflow-y-auto overscroll-contain px-1"
          >
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {own.map((row) => (
                <Row key={row.key} row={row} total={report.total} />
              ))}
            </ul>
            {internal.length > 0 ? (
              <>
                <h3 className="mt-2 mb-0 text-xs font-medium text-fg-3">
                  {t("shell.usage.internal")}
                </h3>
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                  {internal.map((row) => (
                    <Row key={row.key} row={row} total={report.total} />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      <p className="m-0 text-2xs text-fg-3">{t("shell.usage.footnote")}</p>
    </div>
  );
}

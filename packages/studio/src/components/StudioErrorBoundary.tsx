import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function ErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-950 font-sans text-neutral-200">
      <div className="text-lg font-semibold">{t("shell.error.title")}</div>
      <div className="max-w-[480px] text-center text-[13px] text-neutral-500">{message}</div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onRetry}
          className="rounded-md bg-studio-accent px-5 py-2 text-sm font-medium text-neutral-950 transition-[filter] hover:brightness-110 active:scale-[0.98]"
        >
          {t("common.tryAgain")}
        </button>
        {/* If the error recurs immediately, "Try again" loops — a full reload
            is the recovery path that always works. */}
        <button
          onClick={() => window.location.reload()}
          className="rounded-md border border-neutral-700 px-5 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 active:scale-[0.98]"
        >
          {t("shell.error.reload")}
        </button>
      </div>
    </div>
  );
}

export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Studio] Uncaught error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <ErrorFallback
        message={this.state.error.message}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

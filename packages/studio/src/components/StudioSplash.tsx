import { Trans, useTranslation } from "../i18n";

export function StudioSplash({ waiting }: { waiting?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="h-full w-full bg-neutral-950 flex items-center justify-center">
      {waiting ? (
        <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
          <div className="w-4 h-4 rounded-full border-2 border-neutral-700 border-t-neutral-500 animate-spin motion-reduce:animate-none" />
          <p className="text-xs text-neutral-600">
            <Trans
              i18nKey="shell.splash.waiting"
              components={{ code: <code className="text-neutral-500 font-mono" /> }}
            />
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
          <div className="w-4 h-4 rounded-full bg-studio-accent animate-pulse motion-reduce:animate-none" />
          <p className="text-xs text-neutral-600">{t("shell.splash.connecting")}</p>
        </div>
      )}
    </div>
  );
}

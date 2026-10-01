/** Small text-button used in the Variables tab rows (Edit / Remove / Set default / Declare). */
export function RowAction({
  label,
  title,
  danger,
  onClick,
}: {
  label: string;
  title: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`h-5 rounded px-1.5 text-2xs text-fg-3 hover:bg-surface-2 ${
        danger ? "hover:text-red-400" : "hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

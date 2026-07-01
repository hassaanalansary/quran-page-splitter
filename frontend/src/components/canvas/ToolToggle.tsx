import type { CanvasTool } from "@/hooks/use-space-pan";

type Props = {
  /** The active tool (pass the *effective* tool so Space-hold shows as hand). */
  value: CanvasTool;
  onChange: (t: CanvasTool) => void;
};

/** Select / Hand tool switch with active-state indication. */
export function ToolToggle({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1">
      <ToolButton
        active={value === "select"}
        onClick={() => onChange("select")}
        title="Select / crop tool (V)"
        aria-label="Select tool"
      >
        <CursorIcon />
      </ToolButton>
      <ToolButton
        active={value === "hand"}
        onClick={() => onChange("hand")}
        title="Hand tool — pan the canvas (H, or hold Space)"
        aria-label="Hand tool"
      >
        <HandIcon />
      </ToolButton>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  title,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      {...rest}
      className={[
        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm transition-colors",
        active
          ? "bg-navy text-white"
          : "bg-transparent text-text-secondary hover:bg-bg-surface hover:text-text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function CursorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 3l6 16 2-7 7-2L5 3z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 11V5.5a1.5 1.5 0 1 1 3 0V11M10 11V4.5a1.5 1.5 0 1 1 3 0V11M13 11V5.5a1.5 1.5 0 1 1 3 0V13M16 8.5a1.5 1.5 0 1 1 3 0V15a6 6 0 0 1-6 6h-1.5a5 5 0 0 1-4.33-2.5L4 13.5a1.6 1.6 0 0 1 2.65-1.75L8 13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

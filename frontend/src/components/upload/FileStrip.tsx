import { useRef } from "react";

type Props = {
  files: File[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onAdd: (files: FileList) => void;
};

export function FileStrip({ files, selectedIndex, onSelect, onAdd }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="flex h-[90px] flex-shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-white px-3 py-2"
      style={{ scrollbarWidth: "thin" }}
    >
      {files.map((f, i) => (
        <button
          key={`${f.name}-${i}`}
          type="button"
          onClick={() => onSelect(i)}
          className={[
            "relative flex h-[68px] w-[52px] flex-shrink-0 cursor-pointer flex-col gap-[2px] overflow-hidden rounded-[4px] border-2 px-[3px] py-1 transition-colors",
            i === selectedIndex
              ? "border-orange bg-orange-tint"
              : "border-border bg-bg-surface hover:border-border-strong",
          ].join(" ")}
          title={f.name}
        >
          {/* simulated page lines */}
          {[6, 4, 7, 5, 6, 4, 7, 5, 6].map((w, k) => (
            <span
              key={k}
              className="h-[2px] rounded-[1px]"
              style={{
                width: `${50 + w * 4}%`,
                background:
                  k === 0
                    ? "color-mix(in oklab, var(--orange) 40%, transparent)"
                    : "color-mix(in oklab, var(--navy) 12%, transparent)",
                marginLeft: "auto",
                marginRight: "auto",
              }}
            />
          ))}
          <span
            className="absolute bottom-[2px] left-0 right-0 text-center text-text-muted"
            style={{
              fontSize: "8px",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            {String(i + 1).padStart(3, "0")}
          </span>
        </button>
      ))}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex h-[68px] w-[52px] flex-shrink-0 cursor-pointer items-center justify-center rounded-[4px] border-2 border-dashed border-border-strong bg-transparent text-[20px] text-text-muted transition-colors hover:border-orange hover:bg-orange-tint hover:text-orange"
        title="Add images"
      >
        +
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onAdd(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

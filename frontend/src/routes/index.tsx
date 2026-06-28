import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CreateMushafDialog } from "@/components/app/CreateMushafDialog";
import {
  ApiError,
  deleteMushaf,
  mushafStatus,
  pageImageUrl,
  queryKeys,
  useMushafs,
  type Mushaf,
  type MushafStatus,
} from "@/lib/api";

export const Route = createFileRoute("/")({ component: HomePage });

const STATUS: Record<MushafStatus, { label: string; dot: string; text: string; bg: string }> = {
  empty: {
    label: "Not processed",
    dot: "var(--text-muted)",
    text: "text-text-muted",
    bg: "bg-bg-muted",
  },
  partial: { label: "Partial", dot: "var(--warning)", text: "text-[#92400E]", bg: "bg-warning-bg" },
  processed: { label: "Processed", dot: "var(--navy-light)", text: "text-navy", bg: "bg-bg-muted" },
  completed: {
    label: "Completed",
    dot: "var(--success)",
    text: "text-success",
    bg: "bg-success-bg",
  },
};

function HomePage() {
  const { data: mushafs, isPending, isError, error } = useMushafs();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-page">
      <header className="flex h-[52px] flex-shrink-0 items-center border-b border-border bg-white px-6">
        <div className="flex items-center gap-2.5">
          <span className="mt-px h-2 w-2 rounded-[2px] bg-orange" />
          <span className="font-display text-[15px] font-bold leading-none text-navy">
            Quran Page Splitter
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-9">
          <div className="mb-7">
            <h1 className="font-display text-2xl font-bold text-navy">Mushafs</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Each mushaf is a PDF processed into per-aya coordinates and transparent line images.
            </p>
          </div>

          {isError ? (
            <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
              {error instanceof Error ? error.message : "Failed to load mushafs."}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-5">
              {isPending
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="aspect-[3/4.3] animate-pulse rounded-xl bg-bg-muted" />
                  ))
                : mushafs.map((m) => <MushafCard key={m.id} mushaf={m} />)}
              {!isPending && <AddCard onClick={() => setCreateOpen(true)} />}
            </div>
          )}
        </div>
      </main>

      <CreateMushafDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function MushafCard({ mushaf }: { mushaf: Mushaf }) {
  const queryClient = useQueryClient();
  const [imgFailed, setImgFailed] = useState(false);
  const status = STATUS[mushafStatus(mushaf)];

  const remove = useMutation({
    mutationFn: () => deleteMushaf(mushaf.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(`Deleted “${mushaf.name}”.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to delete."),
  });

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-white shadow-[var(--shadow-sm)] transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-md)]">
      <Link to="/mushafs/$mushafId/setup" params={{ mushafId: mushaf.id }} className="block">
        {/* Thumbnail */}
        <div className="relative aspect-[3/4] overflow-hidden bg-bg-muted">
          {!imgFailed ? (
            <img
              src={pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
              alt={`${mushaf.name} first page`}
              loading="lazy"
              draggable={false}
              onError={() => setImgFailed(true)}
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
              no preview
            </div>
          )}
          <span
            className={`absolute left-2 top-2 flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[10px] font-semibold ${status.bg} ${status.text}`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.dot }} />
            {status.label}
          </span>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-3 py-2.5">
          <h3 className="truncate text-[13px] font-semibold text-text-primary">{mushaf.name}</h3>
          <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
            <span>
              {mushaf.processed_page_count}/{mushaf.logical_page_count} pages
            </span>
            {mushaf.qiraa && <span className="capitalize">{mushaf.qiraa}</span>}
          </div>
        </div>
      </Link>

      <button
        type="button"
        aria-label={`Delete ${mushaf.name}`}
        title="Delete mushaf"
        onClick={() => {
          if (window.confirm(`Delete “${mushaf.name}” and all its processed data?`))
            remove.mutate();
        }}
        disabled={remove.isPending}
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-white/80 text-text-secondary opacity-0 backdrop-blur transition hover:bg-error-bg hover:text-error group-hover:opacity-100 disabled:opacity-40"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function AddCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex aspect-[3/4.3] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border-strong bg-white/40 text-text-secondary transition hover:border-orange hover:bg-orange-tint hover:text-orange"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-current">
        <Plus size={22} />
      </span>
      <span className="text-[13px] font-semibold">New mushaf</span>
    </button>
  );
}

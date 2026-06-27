import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CreateMushafDialog } from "@/components/app/CreateMushafDialog";
import { Button } from "@/components/ui/button";
import { ApiError, deleteMushaf, queryKeys, useMushafs, type Mushaf } from "@/lib/api";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const { data: mushafs, isPending, isError, error } = useMushafs();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="min-h-screen bg-bg-page">
      <header className="flex h-[60px] items-center border-b border-border bg-white px-6">
        <div className="flex items-center gap-2.5">
          <span className="mt-px h-2 w-2 rounded-[2px] bg-orange" />
          <span className="font-display text-[16px] font-bold leading-none text-navy">
            Quran Page Splitter
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-7 flex items-end justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-navy">Mushafs</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Each mushaf is a PDF processed into per-aya coordinates and line images.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>+ New mushaf</Button>
        </div>

        {isPending ? (
          <CardGrid>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg border border-border bg-white" />
            ))}
          </CardGrid>
        ) : isError ? (
          <ErrorBox message={error instanceof Error ? error.message : "Failed to load mushafs."} />
        ) : mushafs.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <CardGrid>
            {mushafs.map((m) => (
              <MushafCard key={m.id} mushaf={m} />
            ))}
          </CardGrid>
        )}
      </main>

      <CreateMushafDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function MushafCard({ mushaf }: { mushaf: Mushaf }) {
  const queryClient = useQueryClient();
  const total = mushaf.logical_page_count;
  const done = mushaf.processed_page_count;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const remove = useMutation({
    mutationFn: () => deleteMushaf(mushaf.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(`Deleted “${mushaf.name}”.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to delete."),
  });

  return (
    <div className="group relative rounded-lg border border-border bg-white shadow-[var(--shadow-sm)] transition hover:border-border-strong hover:shadow-[var(--shadow-md)]">
      <Link
        to="/mushafs/$mushafId/setup"
        params={{ mushafId: mushaf.id }}
        className="block p-4"
      >
        <div className="flex items-start gap-2 pr-7">
          <h3 className="flex-1 truncate font-semibold text-text-primary">{mushaf.name}</h3>
          {mushaf.qiraa && (
            <span className="rounded-pill bg-bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-text-secondary">
              {mushaf.qiraa}
            </span>
          )}
        </div>

        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
          <div className="h-full rounded-full bg-orange" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
          <span>
            {done} / {total} pages processed
          </span>
          <span>{mushaf.pdf_page_count}-page PDF</span>
        </div>
      </Link>

      <button
        type="button"
        aria-label={`Delete ${mushaf.name}`}
        title="Delete mushaf"
        onClick={() => {
          if (window.confirm(`Delete “${mushaf.name}” and all its processed data?`)) remove.mutate();
        }}
        disabled={remove.isPending}
        className="absolute right-2.5 top-3 flex h-6 w-6 items-center justify-center rounded text-text-muted opacity-0 transition hover:bg-error-bg hover:text-error group-hover:opacity-100 disabled:opacity-50"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-white py-16 text-center">
      <p className="text-sm font-medium text-text-primary">No mushafs yet</p>
      <p className="mt-1 max-w-xs text-sm text-text-muted">
        Upload a Quran PDF to get started — you'll mark the page range, crop templates, then process.
      </p>
      <Button className="mt-5" onClick={onCreate}>
        + New mushaf
      </Button>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
      {message}
    </div>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, createMushaf, DEFAULT_QIRAA, queryKeys, useQiraat } from "@/lib/api";

export function CreateMushafDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: qiraat } = useQiraat();
  const [name, setName] = useState("");
  const [qiraa, setQiraa] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default to Hafs (or the first available) until the user picks another. Keyed
  // by the qiraa's real DB `name` — the value create/PATCH match on exactly.
  const defaultQiraa = useMemo(() => {
    if (!qiraat || qiraat.length === 0) return "";
    const preferred = qiraat.find((q) => q.name.toLowerCase() === DEFAULT_QIRAA);
    return (preferred ?? qiraat[0]).name;
  }, [qiraat]);
  const selectedQiraa = qiraa || defaultQiraa;

  useEffect(() => {
    if (!open) {
      setName("");
      setQiraa("");
      setFile(null);
      setError(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => createMushaf({ pdf: file!, name: name.trim(), qiraa: selectedQiraa }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      if (result.warnings.duplicate_file) {
        toast.warning("This PDF is already uploaded under another mushaf name.");
      }
      toast.success(`Created “${result.mushaf.name}”.`);
      onOpenChange(false);
      navigate({ to: "/mushafs/$mushafId/setup", params: { mushafId: result.mushaf.id } });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed to create mushaf."),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the mushaf a name.");
    if (!file) return setError("Choose a PDF file to upload.");
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New mushaf</DialogTitle>
            <DialogDescription>
              Upload a Quran PDF. You'll mark which pages hold the Quran content next.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mushaf-name">Name</Label>
              <Input
                id="mushaf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Madinah Mushaf"
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mushaf-qiraa">Qiraa</Label>
              <select
                id="mushaf-qiraa"
                value={selectedQiraa}
                onChange={(e) => setQiraa(e.target.value)}
                disabled={!qiraat || qiraat.length === 0}
                className="h-9 cursor-pointer rounded-md border-[1.5px] border-border-strong bg-white px-2.5 text-sm capitalize outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {!qiraat ? (
                  <option value="">Loading…</option>
                ) : qiraat.length === 0 ? (
                  <option value="">No qiraat available</option>
                ) : (
                  qiraat.map((q) => (
                    <option key={q.name} value={q.name}>
                      {q.name} — {q.counting_system}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mushaf-pdf">PDF file</Label>
              <Input
                id="mushaf-pdf"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
              />
              {file && (
                <span className="text-xs text-text-muted">
                  {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Uploading…" : "Create mushaf"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

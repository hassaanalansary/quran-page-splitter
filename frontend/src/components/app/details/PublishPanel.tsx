import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Globe, Lock } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ApiError, publishMushaf, queryKeys, unpublishMushaf, type MushafDetail } from "@/lib/api";

/** Publish / unpublish control on the mushaf's Settings tab.
 *
 * Publishing grants read only — the copy someone else takes is an independent
 * mushaf, so nothing here can be edited by anyone but the owner. That is worth
 * saying plainly in the UI, which is what the body copy does.
 */
export function PublishPanel({ mushaf }: { mushaf: MushafDetail }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(mushaf.description ?? "");
  const isPublished = mushaf.visibility === "published";

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushaf.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
    // The gallery listing is keyed by offset, so drop the whole branch.
    queryClient.invalidateQueries({ queryKey: ["gallery"] });
  }

  const publish = useMutation({
    mutationFn: () => publishMushaf(mushaf.id, description.trim()),
    onSuccess: () => {
      invalidate();
      toast.success(t("gallery.publish.published"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("gallery.publish.failed")),
  });

  const unpublish = useMutation({
    mutationFn: () => unpublishMushaf(mushaf.id),
    onSuccess: () => {
      invalidate();
      toast.success(t("gallery.publish.unpublished"));
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : t("gallery.publish.unpublishFailed")),
  });

  const publishedDate = mushaf.published_at
    ? new Date(mushaf.published_at).toLocaleDateString(i18n.language === "ar" ? "ar" : "en")
    : "";

  return (
    <div className="rounded-[11px] border border-border bg-white p-4">
      <div className="mb-1 flex items-center gap-2 text-[12.5px] font-bold text-text-primary">
        {isPublished ? (
          <Globe className="h-3.5 w-3.5 text-success" />
        ) : (
          <Lock className="h-3.5 w-3.5 text-text-muted" />
        )}
        {isPublished ? t("gallery.publish.liveHeading") : t("gallery.publish.heading")}
      </div>

      <p className="mb-3 text-[10.5px] leading-[1.5] text-text-muted">
        {isPublished
          ? t("gallery.publish.liveBody", { date: publishedDate })
          : t("gallery.publish.body")}
      </p>

      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
        {t("gallery.publish.descriptionLabel")}
      </label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("gallery.publish.descriptionPlaceholder")}
        rows={3}
        className="w-full resize-y rounded-lg border-[1.5px] border-border-strong bg-white px-[11px] py-2 text-[12.5px] font-medium text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isPublished ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
            >
              {publish.isPending ? t("gallery.publish.publishing") : t("gallery.publish.save")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => unpublish.mutate()}
              disabled={unpublish.isPending}
              className="border-error-border text-error hover:bg-error-bg"
            >
              {unpublish.isPending
                ? t("gallery.publish.unpublishing")
                : t("gallery.publish.unpublish")}
            </Button>
            <Link to="/gallery" className="text-[11px] font-semibold text-navy hover:underline">
              {t("gallery.navLink")}
            </Link>
          </>
        ) : (
          <Button size="sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
            <Globe className="h-3.5 w-3.5" />
            {publish.isPending ? t("gallery.publish.publishing") : t("gallery.publish.action")}
          </Button>
        )}
      </div>
    </div>
  );
}

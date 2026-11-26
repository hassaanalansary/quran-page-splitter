import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Globe, Lock } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ApiError, publishMushaf, queryKeys, unpublishMushaf, type MushafDetail } from "@/lib/api";

/** Publish / unpublish control, beside the exports on the hub's Export tab.
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
    <section className="flex flex-col gap-3 rounded-panel border border-rule bg-card p-[18px]">
      <h2 className="m-0 flex items-center gap-2 font-display text-[20px] font-semibold">
        {isPublished ? (
          <Globe className="h-4 w-4 text-done-text" aria-hidden="true" />
        ) : (
          <Lock className="h-4 w-4 text-ink-3" aria-hidden="true" />
        )}
        {isPublished ? t("gallery.publish.liveHeading") : t("gallery.publish.heading")}
      </h2>

      <p className="m-0 text-[13.5px] leading-normal text-ink-2">
        {isPublished
          ? t("gallery.publish.liveBody", { date: publishedDate })
          : t("gallery.publish.body")}
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink-2">
          {t("gallery.publish.descriptionLabel")}
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("gallery.publish.descriptionPlaceholder")}
          rows={4}
          dir="auto"
          className="w-full resize-y rounded-control border border-rule-2 bg-card px-3 py-2.5 text-[14px] text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)]"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {isPublished ? (
          <>
            <button
              type="button"
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
              className="inline-flex h-10 cursor-pointer items-center rounded-control border border-rule-2 bg-card px-4 text-[13.5px] font-semibold text-ink hover:bg-sheet disabled:opacity-60"
            >
              {publish.isPending ? t("gallery.publish.publishing") : t("gallery.publish.save")}
            </button>
            <button
              type="button"
              onClick={() => unpublish.mutate()}
              disabled={unpublish.isPending}
              className="inline-flex h-10 cursor-pointer items-center rounded-control border border-stop/30 bg-card px-4 text-[13.5px] font-semibold text-stop-text hover:bg-stop-wash disabled:opacity-60"
            >
              {unpublish.isPending
                ? t("gallery.publish.unpublishing")
                : t("gallery.publish.unpublish")}
            </button>
            <Link
              to="/gallery"
              className="text-[13px] font-semibold text-lapis-text no-underline hover:underline"
            >
              {t("gallery.navLink")}
            </Link>
          </>
        ) : (
          <button
            type="button"
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
            className="inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis hover:bg-lapis/90 disabled:opacity-60"
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            {publish.isPending ? t("gallery.publish.publishing") : t("gallery.publish.action")}
          </button>
        )}
      </div>
    </section>
  );
}

import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ApiError, mediaUrl, useCalibrationComparison } from "@/lib/api";

const READINGS = ["frozen", "canonical", "calibrated", "confirmed"] as const;
const COLORS = {
  frozen: "#b45309",
  canonical: "#2563eb",
  calibrated: "#9333ea",
  confirmed: "#15803d",
};

export function EvaluationComparison({
  mushafId,
  page,
  onClose,
}: {
  mushafId: string;
  page: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useCalibrationComparison(mushafId, page);
  return (
    <Dialog
      open={page !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] w-[96vw] max-w-[1600px] flex-col overflow-hidden bg-white"
        aria-describedby={undefined}
      >
        <DialogTitle className="pe-6 text-base tracking-normal">
          {t("calibration.comparePage", { page })}
        </DialogTitle>
        {isLoading && <p>{t("calibration.evaluationLoading")}</p>}
        {error && (
          <p role="alert">
            {error instanceof ApiError ? error.message : t("calibration.requestFailed")}
          </p>
        )}
        {data && (
          <div className="min-h-0 overflow-auto">
            <p className="mb-3 text-xs text-text-secondary">
              {t("calibration.confirmedAt", { revision: data.confirmed_revision })}
            </p>
            {data.lines.map((line) => (
              <section key={line.line_number} className="border-t border-border py-3">
                <h3 className="mb-2 text-xs font-semibold">
                  {t("calibration.lineLabel", { n: line.line_number })}
                </h3>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-4">
                  {READINGS.map((engine) => (
                    <div key={engine} className="min-w-0">
                      <h4 className="mb-1 text-xs font-semibold" style={{ color: COLORS[engine] }}>
                        {t(`calibration.engine.${engine}`)}
                      </h4>
                      {line.readings[engine].unavailable || !line.image_url ? (
                        <p className="text-xs text-error">
                          {t("calibration.comparisonUnavailable")}
                        </p>
                      ) : (
                        <div
                          className="relative overflow-hidden bg-white"
                          dir="ltr"
                          style={{ aspectRatio: `${line.bbox.w} / ${line.bbox.h}` }}
                        >
                          <img
                            src={mediaUrl(line.image_url)}
                            alt={t("calibration.lineLabel", { n: line.line_number })}
                            className="block h-full w-full"
                          />
                          {line.readings[engine].words.map((word, index) => (
                            <div
                              key={`${word.word_id}-${index}`}
                              title={`${word.word_id ?? "?"}: ${word.start_x}..${word.end_x}`}
                              className="pointer-events-none absolute inset-y-0 border-x-2"
                              style={{
                                left: `${(100 * (word.end_x - line.bbox.x)) / line.bbox.w}%`,
                                width: `${(100 * (word.start_x - word.end_x)) / line.bbox.w}%`,
                                borderColor: COLORS[engine],
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The workspace shell's shared state: which step is on screen, and every step's
// state and sub-line for the spine. The layout route provides the step; the
// inspector (Panel's `Aside`) reads it to title itself.
import { createContext, useContext } from "react";

import {
  pipelineSteps,
  STEP_ROUTES,
  type StepInfo,
  type StepSlug,
} from "@/components/app/details/helpers";
import {
  useCalibrationPages,
  useStats,
  useTemplates,
  type MushafDetail,
  type MushafStats,
} from "@/lib/api";

export const ShellStepContext = createContext<StepSlug | null>(null);

/** The step the shell is showing, or null outside it (the hub, the library). */
export function useShellStep(): StepSlug | null {
  return useContext(ShellStepContext);
}

/** The spine's three phases and their steps, in pipeline order. */
export const PHASES: { key: "prepare" | "linesAyat" | "words"; steps: StepSlug[] }[] = [
  { key: "prepare", steps: ["setup", "templates"] },
  { key: "linesAyat", steps: ["process", "review", "finalize"] },
  { key: "words", steps: ["ink"] },
];

export { STEP_ROUTES };

export type StepStates = {
  steps: Map<StepSlug, StepInfo>;
  stats: MushafStats | undefined;
  inkConfirmed: number;
  inkProcessed: number;
};

/** Every step's state and sub-line, from the same data the hub reads. */
export function useStepStates(mushaf: MushafDetail): StepStates {
  const { data: templates } = useTemplates(mushaf.id);
  const { data: stats } = useStats(mushaf.id);
  // Without it the sixth step could never show a tick.
  const { data: calibrationPages } = useCalibrationPages(mushaf.id);
  const templatesReady =
    !!templates &&
    ["sura_header", "aya_separator"].every((type) => templates.some((tpl) => tpl.type === type));
  const steps = new Map(
    pipelineSteps(mushaf, templatesReady, null, calibrationPages).map((s) => [s.slug, s]),
  );
  const pages = calibrationPages ?? [];
  return {
    steps,
    stats,
    inkConfirmed: pages.filter((p) => p.confirmed_revision !== null).length,
    inkProcessed: pages.filter((p) => p.processed).length,
  };
}

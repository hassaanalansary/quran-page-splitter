import { useCallback, useEffect, useRef, useState } from "react";

export type CanvasTool = "select" | "hand";

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

type UseSpacePanOptions = {
  /** The explicit tool selected by the user (toolbar button, etc.). */
  tool?: CanvasTool;
};

type UseSpacePanReturn = {
  /** Ref to attach to the scrollable container. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The tool that is effectively active right now (considers space-held). */
  effectiveTool: CanvasTool;
  /** Whether the user is actively panning (mouse is down in hand mode). */
  panning: boolean;
  /** Cursor string to apply when hand mode is active. */
  handCursor: "grab" | "grabbing";
  /** Spread these props onto the scrollable container div. */
  containerProps: {
    tabIndex: number;
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  };
};

/**
 * Encapsulates the "space-to-pan" pattern used in image-editor-style canvases.
 *
 * - Holding **Space** temporarily activates the hand/pan tool.
 * - While the hand tool is active, pointer-dragging scrolls the container.
 * - Prevents the browser's native "space scrolls the page" behaviour.
 */
export function useSpacePan(opts: UseSpacePanOptions = {}): UseSpacePanReturn {
  const { tool = "select" } = opts;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panRef = useRef<{
    x: number;
    y: number;
    sl: number;
    st: number;
    id: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const effectiveTool: CanvasTool = tool === "hand" || spaceHeld ? "hand" : "select";

  // ── Space key listener ──
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }

    // Attach to the scroll container so preventDefault beats the native scroll
    const el = scrollRef.current;
    el?.addEventListener("keydown", onKeyDown);
    // Also attach to window to catch Space when focus is elsewhere
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      el?.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ── Pointer pan handlers ──
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (effectiveTool !== "hand" || !scrollRef.current) return;
      e.preventDefault();
      const el = scrollRef.current;
      panRef.current = {
        x: e.clientX,
        y: e.clientY,
        sl: el.scrollLeft,
        st: el.scrollTop,
        id: e.pointerId,
      };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      setPanning(true);
    },
    [effectiveTool],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || !scrollRef.current) return;
    scrollRef.current.scrollLeft = p.sl - (e.clientX - p.x);
    scrollRef.current.scrollTop = p.st - (e.clientY - p.y);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(panRef.current.id);
    panRef.current = null;
    setPanning(false);
  }, []);

  const handCursor = panning ? "grabbing" : "grab";

  return {
    scrollRef,
    effectiveTool,
    panning,
    handCursor,
    containerProps: {
      tabIndex: -1,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

/**
 * Read-only tracker for the global "Space held" state.
 *
 * Used by toolbar indicators that need to reflect the temporary hand-tool
 * activation while the user holds Space, without owning the full pan logic.
 */
export function useSpaceHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && !isTyping(e.target) && !e.repeat) setHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
  return held;
}

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  COLLAPSED_PANEL_WIDTH_PX,
  DEFAULT_DOCK_TAB,
  DEFAULT_PANE_SIZES,
  DESKTOP_BREAKPOINT_PX,
  LAYOUT_STORAGE_KEY,
  PANE_BOUNDS
} from "../model/constants";
import { clamp } from "../model/formatters";
import type { ActiveSplitter, DockTab, PersistedLayoutV1, UtilityTab, WorkspacePaneSizes } from "../model/types";

function clampPaneSizes(sizes: WorkspacePaneSizes): WorkspacePaneSizes {
  return {
    left: Math.round(clamp(sizes.left, PANE_BOUNDS.left.min, PANE_BOUNDS.left.max)),
    right: Math.round(clamp(sizes.right, PANE_BOUNDS.right.min, PANE_BOUNDS.right.max))
  };
}

function readPersistedLayout(): PersistedLayoutV1 | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedLayoutV1>;
    const left = Number(parsed.left);
    const right = Number(parsed.right);
    const dockTab = parsed.dockTab;
    if (
      !parsed ||
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      (dockTab !== "timeline" && dockTab !== "export")
    ) {
      return null;
    }

    return {
      left,
      right,
      dockTab,
      leftCollapsed: parsed.leftCollapsed === true,
      rightCollapsed: parsed.rightCollapsed === true
    };
  } catch {
    return null;
  }
}

function isDesktopViewportWidth(width: number): boolean {
  return width >= DESKTOP_BREAKPOINT_PX;
}

interface SplitterDragState {
  splitter: Exclude<ActiveSplitter, null>;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSizes: WorkspacePaneSizes;
}

export function useWorkspaceLayout() {
  const [dockTab, setDockTab] = useState<DockTab>(() => readPersistedLayout()?.dockTab ?? DEFAULT_DOCK_TAB);
  const [utilityTab, setUtilityTab] = useState<UtilityTab>("crop");
  const [workspacePaneSizes, setWorkspacePaneSizes] = useState<WorkspacePaneSizes>(() => {
    const persisted = readPersistedLayout();
    return clampPaneSizes(
      persisted
        ? {
            left: persisted.left,
            right: persisted.right
          }
        : DEFAULT_PANE_SIZES
    );
  });
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(
    () => readPersistedLayout()?.leftCollapsed === true
  );
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(
    () => readPersistedLayout()?.rightCollapsed === true
  );
  const [activeSplitter, setActiveSplitter] = useState<ActiveSplitter>(null);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() =>
    typeof window === "undefined" ? true : isDesktopViewportWidth(window.innerWidth)
  );
  const splitterDragRef = useRef<SplitterDragState | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResize = (): void => {
      setIsDesktopViewport(isDesktopViewportWidth(window.innerWidth));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const payload: PersistedLayoutV1 = {
      left: workspacePaneSizes.left,
      right: workspacePaneSizes.right,
      dockTab,
      leftCollapsed: isLeftPanelCollapsed,
      rightCollapsed: isRightPanelCollapsed
    };

    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore persistence errors (private mode, quota, etc.)
    }
  }, [
    dockTab,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    workspacePaneSizes.left,
    workspacePaneSizes.right
  ]);

  useEffect(() => {
    if (!isDesktopViewport && activeSplitter !== null) {
      splitterDragRef.current = null;
      setActiveSplitter(null);
    }
  }, [activeSplitter, isDesktopViewport]);

  useEffect(() => {
    if (
      (isLeftPanelCollapsed && activeSplitter === "left") ||
      (isRightPanelCollapsed && activeSplitter === "right")
    ) {
      splitterDragRef.current = null;
      setActiveSplitter(null);
    }
  }, [activeSplitter, isLeftPanelCollapsed, isRightPanelCollapsed]);

  useEffect(() => {
    if (activeSplitter === null || !isDesktopViewport) {
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const drag = splitterDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      event.preventDefault();

      let nextSizes = drag.startSizes;
      if (drag.splitter === "left") {
        const deltaX = event.clientX - drag.startClientX;
        nextSizes = {
          ...drag.startSizes,
          left: drag.startSizes.left + deltaX
        };
      } else {
        const deltaX = event.clientX - drag.startClientX;
        nextSizes = {
          ...drag.startSizes,
          right: drag.startSizes.right - deltaX
        };
      }

      setWorkspacePaneSizes(clampPaneSizes(nextSizes));
    };

    const stopDragging = (event?: PointerEvent): void => {
      const drag = splitterDragRef.current;
      if (!drag) {
        return;
      }
      if (event && event.pointerId !== drag.pointerId) {
        return;
      }
      splitterDragRef.current = null;
      setActiveSplitter(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [activeSplitter, isDesktopViewport]);

  const effectiveLeftPaneWidth =
    isDesktopViewport && isLeftPanelCollapsed ? COLLAPSED_PANEL_WIDTH_PX : workspacePaneSizes.left;
  const effectiveRightPaneWidth =
    isDesktopViewport && isRightPanelCollapsed ? COLLAPSED_PANEL_WIDTH_PX : workspacePaneSizes.right;
  const workstationStyle: CSSProperties = {
    "--workspace-left": `${effectiveLeftPaneWidth}px`,
    "--workspace-right": `${effectiveRightPaneWidth}px`,
    "--workspace-splitter-left": isDesktopViewport && isLeftPanelCollapsed ? "0px" : "8px",
    "--workspace-splitter-right": isDesktopViewport && isRightPanelCollapsed ? "0px" : "8px"
  } as CSSProperties;

  function handleSplitterPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    splitter: Exclude<ActiveSplitter, null>
  ): void {
    if (event.button !== 0 || !isDesktopViewport) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    splitterDragRef.current = {
      splitter,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSizes: workspacePaneSizes
    };
    setActiveSplitter(splitter);
  }

  function resetSplitterSize(splitter: Exclude<ActiveSplitter, null>): void {
    setWorkspacePaneSizes((previous) =>
      clampPaneSizes({
        ...previous,
        [splitter]: DEFAULT_PANE_SIZES[splitter]
      })
    );
  }

  return {
    dockTab,
    setDockTab,
    utilityTab,
    setUtilityTab,
    workspacePaneSizes,
    setWorkspacePaneSizes,
    isLeftPanelCollapsed,
    setIsLeftPanelCollapsed,
    isRightPanelCollapsed,
    setIsRightPanelCollapsed,
    activeSplitter,
    isDesktopViewport,
    workstationStyle,
    handleSplitterPointerDown,
    resetSplitterSize
  };
}

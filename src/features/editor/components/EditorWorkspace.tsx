import type { CSSProperties, ReactNode } from "react";
import type { ActiveSplitter, UtilityTab } from "../model/types";

export interface EditorWorkspaceProps {
  isDesktopViewport: boolean;
  workstationStyle: CSSProperties;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  activeSplitter: ActiveSplitter;
  utilityTab: UtilityTab;
  previewStageContent: ReactNode;
  previewDockContent: ReactNode;
  cropPanelContent: ReactNode;
  inspectorContent: ReactNode;
  onSetIsLeftPanelCollapsed: (collapsed: boolean) => void;
  onSetIsRightPanelCollapsed: (collapsed: boolean) => void;
  onHandleSplitterPointerDown: (event: React.PointerEvent<HTMLDivElement>, splitter: "left" | "right") => void;
  onResetSplitterSize: (splitter: "left" | "right") => void;
  onSetUtilityTab: (tab: UtilityTab) => void;
}

function EditorWorkspace({
  isDesktopViewport,
  workstationStyle,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
  activeSplitter,
  utilityTab,
  previewStageContent,
  previewDockContent,
  cropPanelContent,
  inspectorContent,
  onSetIsLeftPanelCollapsed,
  onSetIsRightPanelCollapsed,
  onHandleSplitterPointerDown,
  onResetSplitterSize,
  onSetUtilityTab
}: EditorWorkspaceProps) {
  return (
    <div
      className={`workspace-shell${isDesktopViewport ? " desktop" : " stacked"}`}
      style={workstationStyle}
    >
      {isDesktopViewport ? (
        <>
          <aside className={`workspace-panel left-tools-panel${isLeftPanelCollapsed ? " collapsed" : ""}`}>
            {isLeftPanelCollapsed ? (
              <button
                className="panel-edge-tab panel-edge-tab-left"
                type="button"
                onClick={() => onSetIsLeftPanelCollapsed(false)}
                aria-label="Open crop panel"
              >
                Crop
              </button>
            ) : (
              <>
                <div className="side-panel-header">
                  <button
                    className="button ghost tiny panel-collapse-trigger"
                    type="button"
                    onClick={() => onSetIsLeftPanelCollapsed(true)}
                  >
                    Hide Panel
                  </button>
                </div>
                {cropPanelContent}
              </>
            )}
          </aside>
          {!isLeftPanelCollapsed && (
            <div
              className={`workspace-splitter vertical splitter-left${
                activeSplitter === "left" ? " active" : ""
              }`}
              onPointerDown={(event) => onHandleSplitterPointerDown(event, "left")}
              onDoubleClick={() => onResetSplitterSize("left")}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize crop panel"
            />
          )}

          <section className="workspace-panel preview-stage-panel">
            {previewStageContent}
            {previewDockContent}
          </section>
          {!isRightPanelCollapsed && (
            <div
              className={`workspace-splitter vertical splitter-right${
                activeSplitter === "right" ? " active" : ""
              }`}
              onPointerDown={(event) => onHandleSplitterPointerDown(event, "right")}
              onDoubleClick={() => onResetSplitterSize("right")}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize inspector panel"
            />
          )}

          <aside className={`workspace-panel inspector-panel${isRightPanelCollapsed ? " collapsed" : ""}`}>
            {isRightPanelCollapsed ? (
              <button
                className="panel-edge-tab panel-edge-tab-right"
                type="button"
                onClick={() => onSetIsRightPanelCollapsed(false)}
                aria-label="Open inspector panel"
              >
                Inspector
              </button>
            ) : (
              <>
                <div className="side-panel-header side-panel-header-right">
                  <button
                    className="button ghost tiny panel-collapse-trigger"
                    type="button"
                    onClick={() => onSetIsRightPanelCollapsed(true)}
                  >
                    Hide Panel
                  </button>
                </div>
                {inspectorContent}
              </>
            )}
          </aside>
        </>
      ) : (
        <>
          <section className="workspace-panel preview-stage-panel">
            {previewStageContent}
            {previewDockContent}
          </section>
          <div className="utility-tabs">
            <button
              className={`dock-tab${utilityTab === "inspector" ? " active" : ""}`}
              type="button"
              onClick={() => onSetUtilityTab("inspector")}
            >
              Inspector
            </button>
            <button
              className={`dock-tab${utilityTab === "crop" ? " active" : ""}`}
              type="button"
              onClick={() => onSetUtilityTab("crop")}
            >
              Crop
            </button>
          </div>
          <section className="workspace-panel stacked-utility-panel">
            {utilityTab === "crop" && cropPanelContent}
            {utilityTab === "inspector" && inspectorContent}
          </section>
        </>
      )}
    </div>
  );
}

export default EditorWorkspace;

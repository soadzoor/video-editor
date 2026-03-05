import type { ReactNode } from "react";
import type { DockTab } from "../model/types";

export interface PreviewDockPanelProps {
  dockTab: DockTab;
  timelineContent: ReactNode;
  exportContent: ReactNode;
  onSetDockTab: (tab: DockTab) => void;
}

function PreviewDockPanel({
  dockTab,
  timelineContent,
  exportContent,
  onSetDockTab
}: PreviewDockPanelProps) {
  return (
    <section className="preview-dock-panel">
      <div className="dock-tabs">
        <button
          className={`dock-tab${dockTab === "timeline" ? " active" : ""}`}
          type="button"
          onClick={() => onSetDockTab("timeline")}
        >
          Timeline
        </button>
        <button
          className={`dock-tab${dockTab === "export" ? " active" : ""}`}
          type="button"
          onClick={() => onSetDockTab("export")}
        >
          Export
        </button>
      </div>
      <div className="dock-content">{dockTab === "timeline" ? timelineContent : exportContent}</div>
    </section>
  );
}

export default PreviewDockPanel;

import CropInspectorPanel from "./CropInspectorPanel";
import EditorWorkspace from "./EditorWorkspace";
import ExportDock from "./ExportDock";
import MediaBinPanel from "./MediaBinPanel";
import PreviewDockPanel from "./PreviewDockPanel";
import PreviewStage from "./PreviewStage";
import SegmentInspectorPanel from "./SegmentInspectorPanel";
import TimelineDock from "./TimelineDock";
import type { EditorPageViewProps } from "../model/controller";

function EditorPageView({
  error,
  fileInputProps,
  globalFileDropBindings,
  mediaBinProps,
  previewStageProps,
  timelineDockProps,
  exportDockProps,
  previewDockTabProps,
  cropInspectorProps,
  segmentInspectorProps,
  workspaceLayoutProps
}: EditorPageViewProps) {
  const mediaBinContent = <MediaBinPanel {...mediaBinProps} />;
  const previewStageContent = <PreviewStage {...previewStageProps} />;
  const timelineDockContent = <TimelineDock {...timelineDockProps} />;
  const exportDockContent = <ExportDock {...exportDockProps} />;
  const previewDockContent = (
    <PreviewDockPanel
      {...previewDockTabProps}
      timelineContent={timelineDockContent}
      exportContent={exportDockContent}
    />
  );
  const cropPanelContent = <CropInspectorPanel {...cropInspectorProps} />;
  const inspectorContent = (
    <div className="inspector-stack">
      <SegmentInspectorPanel {...segmentInspectorProps} />
    </div>
  );

  return (
    <main
      className="app-shell"
      onDrop={globalFileDropBindings.onDrop}
      onDragEnter={globalFileDropBindings.onDragEnter}
      onDragOver={globalFileDropBindings.onDragOver}
      onDragLeave={globalFileDropBindings.onDragLeave}
    >
      {error && <p className="status error">{error}</p>}

      <section className="workspace-panel top-media-panel">
        {mediaBinContent}
        <input
          ref={fileInputProps.ref}
          type="file"
          accept="video/*"
          multiple
          onChange={fileInputProps.onChange}
          hidden
        />
      </section>

      <EditorWorkspace
        {...workspaceLayoutProps}
        previewStageContent={previewStageContent}
        previewDockContent={previewDockContent}
        cropPanelContent={cropPanelContent}
        inspectorContent={inspectorContent}
      />
    </main>
  );
}

export default EditorPageView;

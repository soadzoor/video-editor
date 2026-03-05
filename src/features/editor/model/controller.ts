import type { ChangeEvent, RefObject } from "react";
import type { CropInspectorPanelProps } from "../components/CropInspectorPanel";
import type { EditorWorkspaceProps } from "../components/EditorWorkspace";
import type { ExportDockProps } from "../components/ExportDock";
import type { MediaBinPanelProps } from "../components/MediaBinPanel";
import type { PreviewDockPanelProps } from "../components/PreviewDockPanel";
import type { PreviewStageProps } from "../components/PreviewStage";
import type { SegmentInspectorPanelProps } from "../components/SegmentInspectorPanel";
import type { TimelineDockProps } from "../components/TimelineDock";
import type { GlobalFileDropBindings } from "../hooks/useGlobalFileDrop";

export interface EditorFileInputProps {
  ref: RefObject<HTMLInputElement | null>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export type EditorWorkspaceLayoutProps = Omit<
  EditorWorkspaceProps,
  "previewStageContent" | "previewDockContent" | "cropPanelContent" | "inspectorContent"
>;

export type EditorPreviewDockTabProps = Pick<
  PreviewDockPanelProps,
  "dockTab" | "onSetDockTab"
>;

export interface EditorControllerResult {
  error: string | null;
  fileInputProps: EditorFileInputProps;
  globalFileDropBindings: GlobalFileDropBindings;
  mediaBinProps: MediaBinPanelProps;
  previewStageProps: PreviewStageProps;
  timelineDockProps: TimelineDockProps;
  exportDockProps: ExportDockProps;
  previewDockTabProps: EditorPreviewDockTabProps;
  cropInspectorProps: CropInspectorPanelProps;
  segmentInspectorProps: SegmentInspectorPanelProps;
  workspaceLayoutProps: EditorWorkspaceLayoutProps;
}

export type EditorPageViewProps = EditorControllerResult;

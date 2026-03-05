import { useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { isFileDragPayload } from "../model/formatters";

interface UseGlobalFileDropParams {
  onDropFiles: (files: FileList) => void | Promise<void>;
}

export interface GlobalFileDropBindings {
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
}

export function useGlobalFileDrop({
  onDropFiles
}: UseGlobalFileDropParams): { isDragging: boolean; bindings: GlobalFileDropBindings } {
  const [isDragging, setIsDragging] = useState(false);
  const fileDragDepthRef = useRef(0);

  const onDrop = (event: ReactDragEvent<HTMLElement>): void => {
    if (!isFileDragPayload(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setIsDragging(false);
    void onDropFiles(event.dataTransfer.files);
  };

  const onDragEnter = (event: ReactDragEvent<HTMLElement>): void => {
    if (!isFileDragPayload(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    setIsDragging(true);
  };

  const onDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!isFileDragPayload(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragging) {
      setIsDragging(true);
    }
  };

  const onDragLeave = (event: ReactDragEvent<HTMLElement>): void => {
    if (!isFileDragPayload(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  return {
    isDragging,
    bindings: {
      onDrop,
      onDragEnter,
      onDragOver,
      onDragLeave
    }
  };
}

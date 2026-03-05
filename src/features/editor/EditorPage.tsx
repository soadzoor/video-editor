import EditorPageView from "./components/EditorPageView";
import { useEditorController } from "./hooks/useEditorController";

function EditorPage() {
  const controller = useEditorController();
  return <EditorPageView {...controller} />;
}

export default EditorPage;

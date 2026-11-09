import { useEffect, useState } from "react";
import { Editor } from "./screens/Editor";
import { ProjectList } from "./screens/ProjectList";
import { ALL_DESIGNS, folderViewFromHash } from "./utils/folders";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHashChange = () => {
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const editMatch = /^#\/edit\/(.+)$/.exec(hash);
  const editId = editMatch?.[1];

  if (editId) {
    return <Editor key={editId} designId={editId} />;
  }
  return <ProjectList view={folderViewFromHash(hash) ?? ALL_DESIGNS} />;
}

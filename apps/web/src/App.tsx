import { useEffect, useState } from "react";
import { Editor } from "./screens/Editor";
import { Headless } from "./screens/Headless";
import { ProjectList } from "./screens/ProjectList";
import { ALL_DESIGNS, folderViewFromHash } from "./utils/folders";
import { loadCustomFonts } from "./utils/custom-fonts";
import { shouldHoldNavigation } from "./utils/leave-guard";
import { onLive } from "./utils/live";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    let current = window.location.hash;
    const onHashChange = () => {
      const next = window.location.hash;
      if (next !== current && shouldHoldNavigation(next)) {
        // Stay put while the editor asks how to leave (see leave-guard.ts).
        window.history.replaceState(null, "", current === "" ? window.location.pathname : current);
        return;
      }
      current = next;
      setHash(next);
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

  // Fonts uploaded into MyCanvas (by Luis or Claude), kept current live.
  useEffect(() => {
    void loadCustomFonts();
    return onLive((event) => {
      if (event.type === "fonts.changed" || event.type === "reconnected") {
        void loadCustomFonts();
      }
    });
  }, []);
  const editMatch = /^#\/edit\/(.+)$/.exec(hash);
  const editId = editMatch?.[1];

  if (hash === "#/headless") {
    return <Headless />;
  }
  if (editId) {
    return <Editor key={editId} designId={editId} />;
  }
  return <ProjectList view={folderViewFromHash(hash) ?? ALL_DESIGNS} />;
}

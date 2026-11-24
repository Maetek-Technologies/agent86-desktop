// A highlight.js instance with lowlight's common languages, for code that wants highlight.js
// itself (the Markdown viewer's mdglass). Built from the same grammar modules lowlight imports, so
// the bundle holds one copy of them.
//
// vite.config.ts also points `highlight.js/lib/common` here: that entry re-exports highlight.js's
// CommonJS build, every grammar inlined in one file, which would be a second copy.
import HighlightJs from "highlight.js/lib/core";
import { common } from "lowlight";

const hljs = HighlightJs.newInstance();
for (const [name, language] of Object.entries(common)) hljs.registerLanguage(name, language);

export default hljs;

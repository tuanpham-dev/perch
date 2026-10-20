// The screenshot library the page agent (pageAgent.js) uses, exposed as a
// global because the agent runs as a plain script inside the previewed page.
// Built into each consumer's dist/page-agent.js by extensions/build.mjs.
import * as htmlToImage from "html-to-image";
// Not in the package's index: the agent gathers a page's web fonts itself
// (see fontEmbedCSS in pageAgent.js) and embeds them with this.
import { embedResources } from "html-to-image/es/embed-resources";

(window as unknown as { __perchHtmlToImage: typeof htmlToImage & { embedResources: typeof embedResources } }).__perchHtmlToImage = {
  ...htmlToImage,
  embedResources,
};

// The Mermaid renderer, built to dist/chunks/mermaid.js and import()ed by URL
// the first time a document has a ```mermaid block (see MermaidBlock.tsx), so
// its ~2-3MB stays out of client.js for every Markdown tab without one.
import mermaid from "mermaid";

let seq = 0;
let initializedFor: boolean | null = null;

// Strips anything that could reach the network from rendered SVG. Strict mode
// already drops scripts and click handlers, and HTML labels are off (an HTML
// label is measured in the live page before render() returns, so an <img> in
// one would load before this could remove it); an SVG <image>/<use> can still
// point anywhere. Parsed as HTML: Mermaid's output isn't well-formed XML.
function scrub(svg: string): string {
  const doc = new DOMParser().parseFromString(`<body>${svg}</body>`, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("img, image, script, iframe, object, embed"))) el.remove();
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if ((name === "href" || name === "xlink:href" || name === "src") && !attr.value.startsWith("#")) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

export async function renderMermaid(source: string, dark: boolean): Promise<string> {
  if (initializedFor !== dark) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    initializedFor = dark;
  }
  seq += 1;
  const { svg } = await mermaid.render(`perch-mermaid-${seq}`, source);
  return scrub(svg);
}

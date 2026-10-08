// Minimal XML parser exposing the small DOM surface that parseFeed() uses
// (documentElement, children, localName, getAttribute, textContent).
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function makeElement(tagName, attrs) {
  const el = {
    tagName,
    localName: tagName.split(':').pop(),
    children: [],
    text: '',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); },
  };
  return el;
}

export function parseXml(xml) {
  const stack = [];
  let root = null;
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(token)) {
    const [, close, open, rawAttrs, selfClose, text] = m;
    if (close) stack.pop();
    else if (open) {
      const attrs = {};
      for (const a of (rawAttrs || '').matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
      const el = makeElement(open, attrs);
      stack.at(-1)?.children.push(el);
      root ||= el;
      if (!selfClose) stack.push(el);
    } else if (text && stack.length) stack.at(-1).text += decode(text);
  }
  return { documentElement: root };
}

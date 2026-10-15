---
'@framers/agentos-ext-public-sources': minor
---

`htmlToBlocks(html, { mode: 'page' })` reads any page a citation names: it keeps the tables, figures, quotations, code and notes the page shows, each table cell, caption, quotation and code block a block of its own, and drops the page's own title, scripts, styles, templates, inline SVG, mathematics, hidden elements and Wikipedia's furniture. The article mode, the default, is unchanged.

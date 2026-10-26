/**
 * @fileoverview The sanitized markdown renderer (D19): react-markdown with remark-gfm and
 * rehype-sanitize under the default schema less `img`, no raw HTML, every image dropped (attached
 * pictures alone show, through the product's picture route), and every link opening in a new tab
 * with `rel="noopener noreferrer nofollow ugc"`. A link whose address is not http, https or mailto
 * loses its address.
 */
import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/** The default schema without `img`: an image in a body would load a stranger's server from a reader's browser (D19). Kept to this module: its type reaches into hast-util-sanitize, which the declaration file cannot name. */
const MARKDOWN_SCHEMA = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((name) => name !== 'img'),
};

/** The relation every link carries (D19). */
export const LINK_REL = 'noopener noreferrer nofollow ugc';

const components: Components = {
  a: ({ node: _node, children, href, ...rest }) => (
    <a {...rest} href={href} target="_blank" rel={LINK_REL}>
      {children}
    </a>
  ),
  img: () => null,
};

export interface MarkdownProps {
  /** The message's markdown. */
  readonly body: string;
  readonly className?: string;
}

/** A message's body as sanitized markdown (D19). */
export function Markdown({ body, className }: MarkdownProps): ReactElement {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]} components={components} skipHtml>
        {body}
      </ReactMarkdown>
    </div>
  );
}

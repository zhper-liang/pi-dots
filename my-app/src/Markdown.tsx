import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './markdown.css'

// A bot reply rendered as Markdown (GitHub flavor: tables, task lists, strikethrough).
// Raw HTML stays literal text and unsafe link schemes are dropped (react-markdown defaults).
const components: Components = {
  a: ({ node: _node, href, children, ...props }) => <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  // The page CSP only loads same-origin images, so a picture in a reply opens as a link instead.
  img: ({ src, alt }) => typeof src === 'string' && src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || '图片'}</a> : <>{alt}</>,
  table: ({ node: _node, ...props }) => <div className="md-table"><table {...props} /></div>,
}

export default function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return <div className={`md ${className}`.trim()}><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown></div>
}

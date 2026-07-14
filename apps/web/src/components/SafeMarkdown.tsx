import { Children, type ReactNode, useMemo, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const TOPIC_LINK_PREFIX = "continuum://topic/";

function topicIdentityFromUrl(url: string) {
  if (!url.startsWith(TOPIC_LINK_PREFIX)) return null;
  const encoded = url.slice(TOPIC_LINK_PREFIX.length);
  if (!encoded || encoded.length > 720 || /[/?#]/.test(encoded)) return null;
  try {
    const identity = decodeURIComponent(encoded);
    return /^[A-Za-z0-9-]{1,240}$/.test(identity) ? identity : null;
  } catch { return null; }
}

function safeUrlTransform(url: string) {
  const topicIdentity = topicIdentityFromUrl(url);
  if (topicIdentity) return `${TOPIC_LINK_PREFIX}${encodeURIComponent(topicIdentity)}`;
  const value = defaultUrlTransform(url);
  if (!value) return "";
  if (/^(https?:|mailto:|#|\/)/i.test(value)) return value;
  return "";
}

const KEYWORDS: Record<string, string[]> = {
  javascript: ["async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return", "set", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield"],
  python: ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"],
  shell: ["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local", "readonly", "then", "until", "while"],
  compiled: ["abstract", "as", "async", "break", "case", "catch", "class", "const", "continue", "default", "defer", "do", "else", "enum", "extends", "false", "final", "finally", "fn", "for", "func", "if", "impl", "import", "in", "interface", "let", "match", "mod", "mut", "namespace", "new", "null", "package", "private", "protected", "public", "return", "static", "struct", "super", "switch", "this", "throw", "trait", "true", "try", "type", "use", "var", "void", "where", "while"]
};

function languageFamily(language: string): keyof typeof KEYWORDS | null {
  if (/^(?:js|jsx|javascript|mjs|cjs|ts|tsx|typescript)$/.test(language)) return "javascript";
  if (/^(?:py|python)$/.test(language)) return "python";
  if (/^(?:sh|bash|shell|zsh)$/.test(language)) return "shell";
  if (/^(?:c|cpp|c\+\+|cs|csharp|java|go|golang|rs|rust|swift|kotlin|kt)$/.test(language)) return "compiled";
  return null;
}

function highlightedCode(content: string, language: string): ReactNode[] | string {
  const family = languageFamily(language);
  const json = /^(?:json|jsonc)$/.test(language);
  const markup = /^(?:html|xml|svg)$/.test(language);
  const css = /^(?:css|scss|sass|less)$/.test(language);
  if (!family && !json && !markup && !css) return content;
  const keywords = family ? KEYWORDS[family]!.join("|") : css ? "@(?:charset|container|font-face|import|keyframes|layer|media|namespace|page|property|scope|starting-style|supports)" : "true|false|null";
  const comment = family === "python" || family === "shell" ? "#[^\\n]*" : "\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*";
  const markupToken = markup ? "<\\/?[A-Za-z][^>]*>" : "(?!)";
  const property = json || css ? "(?:\"(?:\\\\.|[^\"\\\\])*\"|--?[A-Za-z_][\\w-]*)(?=\\s*:)" : "(?!)";
  const pattern = new RegExp(`(?<comment>${comment})|(?<markup>${markupToken})|(?<property>${property})|(?<string>"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(?<number>\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b)|(?<keyword>\\b(?:${keywords})\\b)`, family === "python" ? "g" : "gi");
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(content.slice(cursor, index));
    const kind = Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)?.[0] ?? "plain";
    nodes.push(<span className={`syntax-${kind}`} key={`${index}-${kind}`}>{match[0]}</span>);
    cursor = index + match[0].length;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function CodeBlock({ className, children }: { className?: string | undefined; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = className?.replace("language-", "") ?? "text";
  const content = String(children ?? "").replace(/\n$/, "");
  const isInline = !className && !content.includes("\n");
  const highlighted = useMemo(() => highlightedCode(content, language.toLocaleLowerCase()), [content, language]);
  if (isInline) return <code className="inline-code">{children}</code>;
  return <div className="code-block">
    <div className="code-toolbar"><span>{language}</span><button type="button" onClick={() => { void navigator.clipboard.writeText(content); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button></div>
    <pre><code className={className}>{highlighted}</code></pre>
  </div>;
}

export function SafeMarkdown({ children, onTopicLink }: { children: string; onTopicLink?: (topicIdOrSlug: string) => void }) {
  return <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={safeUrlTransform}
      skipHtml
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => <CodeBlock className={className}>{children}</CodeBlock>,
        a: ({ href, children }) => {
          const topicIdentity = href ? topicIdentityFromUrl(href) : null;
          if (topicIdentity) return <button type="button" className="markdown-topic-link" disabled={!onTopicLink} onClick={() => onTopicLink?.(topicIdentity)}>{children}</button>;
          return <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">{children}{href?.startsWith("http") && <ExternalLink size={12} aria-hidden="true" />}</a>;
        },
        table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
        img: ({ src, alt }) => src ? <img src={src} alt={alt ?? ""} loading="lazy" /> : null,
        p: ({ children }) => Children.count(children) ? <p>{children}</p> : null
      }}
    >{children}</ReactMarkdown>
  </div>;
}

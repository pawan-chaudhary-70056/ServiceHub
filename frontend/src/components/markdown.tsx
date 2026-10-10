import type { ReactNode } from 'react';

/**
 * A dependency-free Markdown renderer (docs/27 §3, rule K2).
 *
 * Two decisions matter:
 *
 *   1. It builds **React elements**, never `dangerouslySetInnerHTML`. There is no HTML
 *      string to inject into, so a stored payload cannot become stored XSS (`docs/17`).
 *   2. It renders a deliberate subset — headings, lists, fenced code, emphasis, inline
 *      code and links — and treats everything else as literal text. A construct it does
 *      not understand renders as text, never as markup.
 *
 * The API independently **rejects** a body carrying raw HTML (rule K2); this renderer is
 * the second, independent control — the one that holds if that check is ever bypassed.
 */

/** Only `http(s)` links become anchors: `javascript:` and `data:` render as plain text. */
const SAFE_HREF = /^https?:\/\//i;

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;

    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-surface-muted px-1 py-0.5 text-sm">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const close = token.indexOf(']');
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      if (SAFE_HREF.test(href)) {
        nodes.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand underline"
          >
            {label}
          </a>,
        );
      } else {
        // An unsafe scheme renders as the literal source text, so the reader sees what was
        // written and nothing is silently dropped.
        nodes.push(token);
      }
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6'] as const;

const HEADING_CLASSES = [
  'mt-6 text-xl font-semibold text-content',
  'mt-5 text-lg font-semibold text-content',
  'mt-4 text-base font-semibold text-content',
  'mt-3 text-sm font-semibold text-content',
  'mt-3 text-sm font-semibold text-content',
];

const UNORDERED_ITEM = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;

export interface MarkdownProps {
  source: string;
}

export function Markdown({ source }: MarkdownProps) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // A fenced code block is collected verbatim and never inline-parsed.
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // consume the closing fence
      blocks.push(
        <pre
          key={`code-${key++}`}
          className="overflow-x-auto rounded border border-border bg-surface-muted p-3 text-sm"
        >
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length, 5);
      const Tag = HEADING_TAGS[level - 1] ?? 'h6';
      const headingKey = `h-${key++}`;
      blocks.push(
        <Tag key={headingKey} className={HEADING_CLASSES[level - 1]}>
          {renderInline(heading[2] ?? '', headingKey)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const ordered = ORDERED_ITEM.test(line);
      const items: ReactNode[] = [];
      const listKey = `list-${key++}`;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const item = ordered ? ORDERED_ITEM.exec(current) : UNORDERED_ITEM.exec(current);
        if (!item) break;
        items.push(
          <li key={`${listKey}-${items.length}`}>{renderInline(item[1] ?? '', listKey)}</li>,
        );
        i += 1;
      }
      blocks.push(
        ordered ? (
          <ol key={listKey} className="ml-5 list-decimal space-y-1 text-content">
            {items}
          </ol>
        ) : (
          <ul key={listKey} className="ml-5 list-disc space-y-1 text-content">
            {items}
          </ul>
        ),
      );
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = [];
    const paragraphKey = `p-${key++}`;
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        current.trimStart().startsWith('```') ||
        /^(#{1,6})\s+/.test(current) ||
        UNORDERED_ITEM.test(current) ||
        ORDERED_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      i += 1;
    }
    blocks.push(
      <p key={paragraphKey} className="text-content">
        {renderInline(paragraph.join(' '), paragraphKey)}
      </p>,
    );
  }

  return <div className="space-y-3 text-sm leading-relaxed">{blocks}</div>;
}

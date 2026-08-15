// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Letta AI

import type { RawBodyRange } from '../types/BodyRange.std.ts';
import { BodyRange } from '../types/BodyRange.std.ts';

export type FormattedLettaMessage = Readonly<{
  body: string;
  bodyRanges: ReadonlyArray<RawBodyRange>;
}>;

type InlineStyle = Readonly<{
  marker: string;
  style: BodyRange.Style;
}>;

const INLINE_STYLES: ReadonlyArray<InlineStyle> = [
  { marker: '**', style: BodyRange.Style.BOLD },
  { marker: '__', style: BodyRange.Style.BOLD },
  { marker: '~~', style: BodyRange.Style.STRIKETHROUGH },
  { marker: '`', style: BodyRange.Style.MONOSPACE },
  { marker: '*', style: BodyRange.Style.ITALIC },
  { marker: '_', style: BodyRange.Style.ITALIC },
];

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === '\\';
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findClosingMarker(
  text: string,
  marker: string,
  start: number
): number {
  let cursor = text.indexOf(marker, start);
  while (cursor >= 0) {
    if (!isEscaped(text, cursor)) {
      return cursor;
    }
    cursor = text.indexOf(marker, cursor + marker.length);
  }
  return -1;
}

function canUseSingleMarker(
  text: string,
  marker: string,
  start: number,
  end: number
): boolean {
  if (marker !== '_') {
    return true;
  }
  const before = text[start - 1];
  const after = text[end + 1];
  return !(
    before &&
    after &&
    /[\p{L}\p{N}]/u.test(before) &&
    /[\p{L}\p{N}]/u.test(after)
  );
}

function formatInline(markdown: string): FormattedLettaMessage {
  let body = '';
  const bodyRanges: Array<RawBodyRange> = [];

  for (let cursor = 0; cursor < markdown.length; ) {
    if (markdown[cursor] === '\\' && cursor + 1 < markdown.length) {
      body += markdown[cursor + 1];
      cursor += 2;
      continue;
    }

    let matched = false;
    for (const { marker, style } of INLINE_STYLES) {
      if (!markdown.startsWith(marker, cursor)) {
        continue;
      }
      if (
        marker.length === 1 &&
        markdown.startsWith(marker.repeat(2), cursor)
      ) {
        continue;
      }

      const end = findClosingMarker(markdown, marker, cursor + marker.length);
      if (
        end <= cursor + marker.length ||
        !canUseSingleMarker(markdown, marker, cursor, end)
      ) {
        continue;
      }

      const innerMarkdown = markdown.slice(cursor + marker.length, end);
      const inner =
        style === BodyRange.Style.MONOSPACE
          ? { body: innerMarkdown, bodyRanges: [] }
          : formatInline(innerMarkdown);
      const rangeStart = body.length;
      body += inner.body;
      for (const range of inner.bodyRanges) {
        bodyRanges.push({ ...range, start: range.start + rangeStart });
      }
      if (inner.body.length > 0) {
        bodyRanges.push({
          start: rangeStart,
          length: inner.body.length,
          style,
        });
      }
      cursor = end + marker.length;
      matched = true;
      break;
    }

    if (!matched) {
      body += markdown[cursor];
      cursor += 1;
    }
  }

  return { body, bodyRanges };
}

function formatLine(line: string, inCodeFence: boolean): FormattedLettaMessage {
  if (inCodeFence) {
    return {
      body: line,
      bodyRanges:
        line.length > 0
          ? [
              {
                start: 0,
                length: line.length,
                style: BodyRange.Style.MONOSPACE,
              },
            ]
          : [],
    };
  }

  const heading = line.match(/^ {0,3}#{1,6}\s+(.+)$/);
  if (heading?.[1]) {
    const formatted = formatInline(heading[1]);
    return {
      body: formatted.body,
      bodyRanges: [
        ...formatted.bodyRanges,
        {
          start: 0,
          length: formatted.body.length,
          style: BodyRange.Style.BOLD,
        },
      ],
    };
  }

  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const prefix = `${task[1] ?? ''}${task[2]?.toLowerCase() === 'x' ? '☑' : '☐'} `;
    const formatted = formatInline(task[3] ?? '');
    return {
      body: prefix + formatted.body,
      bodyRanges: formatted.bodyRanges.map(range => ({
        ...range,
        start: range.start + prefix.length,
      })),
    };
  }

  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) {
    const prefix = `${bullet[1] ?? ''}• `;
    const formatted = formatInline(bullet[2] ?? '');
    return {
      body: prefix + formatted.body,
      bodyRanges: formatted.bodyRanges.map(range => ({
        ...range,
        start: range.start + prefix.length,
      })),
    };
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    const formatted = formatInline(quote[1] ?? '');
    return {
      body: formatted.body,
      bodyRanges:
        formatted.body.length > 0
          ? [
              ...formatted.bodyRanges,
              {
                start: 0,
                length: formatted.body.length,
                style: BodyRange.Style.ITALIC,
              },
            ]
          : [],
    };
  }

  return formatInline(line);
}

export function formatLettaMarkdown(markdown: string): FormattedLettaMessage {
  const lines = markdown.split('\n');
  let body = '';
  const bodyRanges: Array<RawBodyRange> = [];
  let inCodeFence = false;
  let hasOutputLine = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }

    const formatted = formatLine(line, inCodeFence);
    if (hasOutputLine) {
      body += '\n';
    }
    const offset = body.length;
    body += formatted.body;
    for (const range of formatted.bodyRanges) {
      bodyRanges.push({ ...range, start: range.start + offset });
    }
    hasOutputLine = true;
  }

  return { body, bodyRanges };
}

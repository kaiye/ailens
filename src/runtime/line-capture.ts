import * as vscode from 'vscode';
import { LineContent } from '../hashing/line-inference';

export function buildDeleteRecords(
  snapshot: { version: number; timestamp: number; lineContents: string[] } | undefined,
  startLine: number,
  endLine: number,
  timestamp: number,
  fileName: string
): LineContent[] {
  if (!snapshot) return [];
  const out: LineContent[] = [];
  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    if (lineNum < snapshot.lineContents.length) {
      out.push({ lineNumber: lineNum, content: snapshot.lineContents[lineNum], operation: '-', timestamp, fileName });
    }
  }
  return out;
}

export function buildInsertRecords(
  document: vscode.TextDocument,
  change: vscode.TextDocumentContentChangeEvent,
  snapshot: { version: number; timestamp: number; lineContents: string[] } | undefined,
  timestamp: number,
  fileName: string
): LineContent[] {
  const out: LineContent[] = [];
  const targetLine = change.range.start.line;
  if (snapshot && targetLine < snapshot.lineContents.length) {
    out.push({ lineNumber: targetLine, content: snapshot.lineContents[targetLine], operation: '-', timestamp, fileName });
  }
  const newLines = change.text.split('\n');
  const isMultiLine = newLines.length > 1;
  if (isMultiLine) {
    for (let i = 0; i < newLines.length; i++) {
      const currentLine = targetLine + i;
      if (currentLine < document.lineCount) {
        out.push({ lineNumber: currentLine, content: document.lineAt(currentLine).text, operation: '+', timestamp, fileName });
      }
    }
  } else {
    if (targetLine < document.lineCount) {
      out.push({ lineNumber: targetLine, content: document.lineAt(targetLine).text, operation: '+', timestamp, fileName });
    }
  }
  return out;
}

export function buildReplaceRecords(
  document: vscode.TextDocument,
  change: vscode.TextDocumentContentChangeEvent,
  snapshot: { version: number; timestamp: number; lineContents: string[] } | undefined,
  timestamp: number,
  fileName: string
): LineContent[] {
  const out: LineContent[] = [];
  const startLine = change.range.start.line;
  const endLine = change.range.end.line;
  if (snapshot) {
    for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
      if (lineNum < snapshot.lineContents.length) {
        out.push({ lineNumber: lineNum, content: snapshot.lineContents[lineNum], operation: '-', timestamp, fileName });
      }
    }
  }
  const newLines = change.text.split('\n');
  for (let i = 0; i < newLines.length; i++) {
    const currentLine = startLine + i;
    if (currentLine < document.lineCount) {
      out.push({ lineNumber: currentLine, content: document.lineAt(currentLine).text, operation: '+', timestamp, fileName });
    }
  }
  return out;
}


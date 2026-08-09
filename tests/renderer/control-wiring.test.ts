import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('renderer control wiring', () => {
  it('does not render enabled button elements without an action', async () => {
    const root = resolve('src', 'renderer');
    const files = (await readdir(root)).filter((name) => name.endsWith('.tsx'));
    const inert: string[] = [];
    for (const file of files) {
      const sourceText = await readFile(resolve(root, file), 'utf8');
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'button') {
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
          const names = new Set(attributes.map((attribute) => attribute.name.getText(source)));
          const type = attributes.find((attribute) => attribute.name.getText(source) === 'type')?.initializer;
          const submits = type && ts.isStringLiteral(type) && type.text === 'submit';
          if (!names.has('onClick') && !names.has('onPointerDown') && !names.has('disabled') && !submits) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            inert.push(`${file}:${position.line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(inert, `Enabled buttons without an action: ${inert.join(', ')}`).toEqual([]);
  });
});
